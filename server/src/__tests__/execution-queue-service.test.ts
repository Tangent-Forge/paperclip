import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionQueueService } from "../services/execution-queue.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution queue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution queue service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-queue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests, so
    // runs must be deleted first — dispatchNext's real (unstubbed) wakeup()
    // links the two, unlike a bare test fixture row.
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { mode?: "observe" | "controlled" } = {}) {
    const companyId = randomUUID();
    const readyAgentId = randomUUID();
    const pausedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Queue Co",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: {
        executionQueueMode: input.mode ?? "observe",
        executionQueueMaxActiveRunsPerAgent: 1,
      },
    });
    await db.insert(agents).values([
      {
        id: readyAgentId,
        companyId,
        name: "Ready agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        // wakeOnDemand:true — dispatchNext's wakeup() calls use source:"automation",
        // not "timer", so this must be set or the real (unstubbed, since the
        // atomic rewrite) wakeup() rejects every dispatch before this test's
        // assertions ever get to see real classifier/lock behavior.
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
      {
        id: pausedAgentId,
        companyId,
        name: "Paused agent",
        role: "engineer",
        status: "paused",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, readyAgentId, pausedAgentId };
  }

  it("shows only explicit-ready work in priority order and does not treat a backlog parent as a dependency", async () => {
    const { companyId, readyAgentId, pausedAgentId } = await seed();
    const parentId = randomUUID();
    const criticalId = randomUUID();
    const childId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const unassignedId = randomUUID();
    const pausedId = randomUUID();

    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parked parent", identifier: "Q-1", status: "backlog", priority: "high" },
      { id: criticalId, companyId, title: "Critical execution", identifier: "Q-2", status: "todo", priority: "critical", assigneeAgentId: readyAgentId },
      { id: childId, companyId, parentId, title: "Ready child", identifier: "Q-3", status: "todo", priority: "high", assigneeAgentId: readyAgentId },
      { id: blockerId, companyId, title: "Parked blocker", identifier: "Q-4", status: "backlog", priority: "high" },
      { id: blockedId, companyId, title: "Blocked by explicit relation", identifier: "Q-5", status: "todo", priority: "high", assigneeAgentId: readyAgentId },
      { id: unassignedId, companyId, title: "No owner", identifier: "Q-6", status: "todo", priority: "medium" },
      { id: pausedId, companyId, title: "Paused owner", identifier: "Q-7", status: "todo", priority: "medium", assigneeAgentId: pausedAgentId },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const queue = await executionQueueService(db).summary(companyId);

    expect(queue.mode).toBe("observe");
    expect(queue.runnable.map((item) => item.issueId)).toEqual([criticalId, childId]);
    expect(queue.runnable[1]?.detail).toContain("controlled");
    expect(queue.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: blockedId, reason: "explicit_blocker" }),
      expect.objectContaining({ issueId: unassignedId, reason: "unassigned" }),
      expect.objectContaining({ issueId: pausedId, reason: "agent_not_invokable" }),
    ]));
    expect(queue.held).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: parentId, reason: "backlog" }),
    ]));
  });

  it("dispatches exactly the highest-priority item only in controlled mode", async () => {
    const { companyId, readyAgentId } = await seed({ mode: "controlled" });
    const lowId = randomUUID();
    const criticalId = randomUUID();
    await db.insert(issues).values([
      { id: lowId, companyId, title: "Low", identifier: "Q-10", status: "todo", priority: "low", assigneeAgentId: readyAgentId },
      { id: criticalId, companyId, title: "Critical", identifier: "Q-11", status: "todo", priority: "critical", assigneeAgentId: readyAgentId },
    ]);

    // autoStartAfterDispatch:false keeps this test scoped to what it actually
    // asserts (which issue got reserved, and that a real run row exists for
    // it) — the reservation itself, and the wakeup() call inside it, are the
    // real (unstubbed) implementation; only the post-commit "start it for
    // real" step, which needs an adapter this fixture has none of, is skipped.
    const queue = executionQueueService(db, { autoStartAfterDispatch: false });

    const result = await queue.dispatchNext(companyId);

    expect(result).toMatchObject({ disposition: "queued", issueId: criticalId });
    expect(result.runId).toBeTruthy();

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, readyAgentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(result.runId);
    expect((runs[0]?.contextSnapshot as Record<string, unknown> | null)?.issueId).toBe(criticalId);

    // The low-priority issue was correctly passed over, not touched at all.
    const lowRuns = runs.filter((run) => (run.contextSnapshot as Record<string, unknown> | null)?.issueId === lowId);
    expect(lowRuns).toHaveLength(0);
  });

  it("does not dispatch while the queue is in observe mode", async () => {
    const { companyId, readyAgentId } = await seed({ mode: "observe" });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready but observed",
      identifier: "Q-20",
      status: "todo",
      priority: "high",
      assigneeAgentId: readyAgentId,
    });

    await expect(executionQueueService(db).dispatchNext(companyId)).rejects.toThrow("observe mode");
  });
});
