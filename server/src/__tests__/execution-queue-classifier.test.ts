import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueRelations,
  issueTreeHolds,
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
    `Skipping embedded Postgres execution queue classifier tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Covers the buckets and paths the original execution-queue-service.test.ts left
// untested: budget_blocked, tree_hold, human_owned, dispatchNext's empty-queue
// path, and a regression for the bounded (terminal-excluded) issues query.
//
// `unassigned` and `agent_not_invokable` are already covered by
// execution-queue-service.test.ts's first case and are not duplicated here.
describeEmbeddedPostgres("execution queue classifier — remaining buckets", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-queue-classifier-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests, so
    // runs must be deleted first — same real (unstubbed) wakeup() concern as
    // execution-queue-service.test.ts.
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueTreeHolds);
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
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
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Classifier Co",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Classifier agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("puts an issue in budget_blocked when its agent's cost hard-stop is exceeded, without pausing the agent", async () => {
    const { companyId, agentId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Over budget",
      identifier: "K-1",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "anthropic",
      model: "test-model",
      costCents: 150,
      occurredAt: new Date(),
    });

    const queue = await executionQueueService(db).summary(companyId);

    // The agent itself is never paused by this — only its budget policy is
    // exceeded — so this must NOT be misclassified as agent_not_invokable.
    expect(queue.blocked.find((entry) => entry.issueId === issueId)).toBeUndefined();
    expect(queue.held).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId, reason: "budget_blocked" }),
    ]));
    expect(queue.runnable.find((entry) => entry.issueId === issueId)).toBeUndefined();
  });

  it("puts an issue in tree_hold when an active pause hold covers it", async () => {
    const { companyId, agentId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paused tree",
      identifier: "K-2",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "Manual investigation in progress.",
    });

    const queue = await executionQueueService(db).summary(companyId);

    expect(queue.held).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId, reason: "tree_hold", detail: "Manual investigation in progress." }),
    ]));
    expect(queue.runnable.find((entry) => entry.issueId === issueId)).toBeUndefined();
  });

  it("puts an issue in human_owned when a user, not an agent, owns the next action", async () => {
    const { companyId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Human owns this",
      identifier: "K-3",
      status: "todo",
      priority: "high",
      assigneeUserId: "user-1",
    });

    const queue = await executionQueueService(db).summary(companyId);

    expect(queue.waiting).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId, reason: "human_owned" }),
    ]));
  });

  it("dispatchNext reports not_dispatched and calls no wakeup when the runnable queue is empty", async () => {
    const { companyId, agentId } = await seed({ mode: "controlled" });
    const issueId = randomUUID();
    // Blocked, not runnable — the queue has real work, just none of it eligible.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Not eligible",
      identifier: "K-4",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const queue = executionQueueService(db, { autoStartAfterDispatch: false });
    const result = await queue.dispatchNext(companyId);

    expect(result).toEqual({
      disposition: "not_dispatched",
      issueId: null,
      runId: null,
      reason: "No runnable issue is available.",
    });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("excludes done and cancelled issues from every bucket, and a cancelled blocker no longer blocks", async () => {
    const { companyId, agentId } = await seed();
    const doneId = randomUUID();
    const cancelledId = randomUUID();
    const cancelledBlockerId = randomUUID();
    const formerlyBlockedId = randomUUID();
    await db.insert(issues).values([
      { id: doneId, companyId, title: "Done", identifier: "K-5", status: "done", priority: "high", assigneeAgentId: agentId },
      { id: cancelledId, companyId, title: "Cancelled", identifier: "K-6", status: "cancelled", priority: "high", assigneeAgentId: agentId },
      { id: cancelledBlockerId, companyId, title: "Cancelled blocker", identifier: "K-7", status: "cancelled", priority: "high" },
      { id: formerlyBlockedId, companyId, title: "Unblocked by cancellation", identifier: "K-8", status: "todo", priority: "high", assigneeAgentId: agentId },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: cancelledBlockerId,
      relatedIssueId: formerlyBlockedId,
      type: "blocks",
    });

    const queue = await executionQueueService(db).summary(companyId);

    const allEntries = [...queue.runnable, ...queue.waiting, ...queue.blocked, ...queue.held];
    expect(allEntries.some((entry) => entry.issueId === doneId)).toBe(false);
    expect(allEntries.some((entry) => entry.issueId === cancelledId)).toBe(false);
    expect(allEntries.some((entry) => entry.issueId === cancelledBlockerId)).toBe(false);
    // A cancelled blocker is resolved, not outstanding — this issue must be runnable.
    expect(queue.runnable).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: formerlyBlockedId, reason: "ready" }),
    ]));
  });
});
