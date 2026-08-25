import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres controlled execution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat controlled execution gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-controlled-execution-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests, so runs
    // must be deleted first. The concurrency test below dispatches with
    // autoStartQueuedRuns: false, so a winning dispatch only ever creates these
    // two rows — no real execution runs, so no other table is touched.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Controlled queue",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: {
        executionQueueMode: "controlled",
        executionQueueMaxActiveRunsPerAgent: 1,
      },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Queue worker",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Controlled issue",
      identifier: "C-1",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  it("suppresses direct todo wakes and enforces the per-agent WIP limit for queue dispatches", async () => {
    const { companyId, agentId, issueId } = await seed();
    // Both dispatches below are expected to be suppressed (return null) before
    // wakeup() ever reaches its auto-start step, but disabling it explicitly
    // keeps this test inert to real execution regardless.
    const heartbeat = heartbeatService(db, { autoStartQueuedRuns: false });

    const directWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, source: "issue.assignment" },
    });
    expect(directWake).toBeNull();

    const [directSkip] = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests);
    expect(directSkip?.reason).toBe("execution_control.queue_required");

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: { issueId: randomUUID() },
    });

    const queueWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "execution_queue_dispatch",
      payload: { issueId },
      contextSnapshot: { issueId, source: "execution.queue", executionQueueDispatch: true },
    });
    expect(queueWake).toBeNull();

    const reasons = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests);
    expect(reasons.map((row) => row.reason)).toContain("execution_control.wip_limit");
  });

  const RACER_COUNT = 6;

  async function seedRaceableQueueIssues(count: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Concurrent queue",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: {
        executionQueueMode: "controlled",
        executionQueueMaxActiveRunsPerAgent: 1,
      },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent queue worker",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    const issueIds = Array.from({ length: count }, () => randomUUID());
    await db.insert(issues).values(
      issueIds.map((id, index) => ({
        id,
        companyId,
        title: `Racer issue ${index}`,
        identifier: `D-${index + 1}`,
        status: "todo" as const,
        priority: "high" as const,
        assigneeAgentId: agentId,
      })),
    );
    return { companyId, agentId, issueIds };
  }

  // The design claim is that a per-agent row lock (SELECT ... FOR UPDATE, taken
  // before the WIP count is read, inside the same transaction as the eventual
  // insert) makes the limit hold even when dispatches race, not just when they
  // arrive one after another. This exercises that directly, with real concurrent
  // connections (createDb's pool is not size-limited) and enough simultaneous
  // racers to reliably open the race window: two racers rarely overlapped widely
  // enough on this embedded database to expose the bug even with the lock
  // temporarily removed during verification; six consistently did.
  it("under real concurrency, exactly one of six simultaneous queue dispatches for the same agent succeeds", async () => {
    const { agentId, issueIds } = await seedRaceableQueueIssues(RACER_COUNT);
    // autoStartQueuedRuns: false leaves every gate this test cares about fully
    // real — policy checks, the controlled-queue todo-suppression, and the WIP
    // row lock all still run inside wakeup() exactly as in production. It only
    // suppresses wakeup()'s very last step: the fire-and-forget call that would
    // start the winning run executing. That step exists to route the run to a
    // real adapter, which this test has none of (an embedded-Postgres-only
    // fixture, no process runner) — without the flag, the resulting fire-and-
    // forget failure/cleanup can still be in flight when the test process tears
    // the database down, which is exactly the non-deterministic, unrelated
    // failure mode this flag exists to rule out at the source, not paper over
    // with a drain-and-wait.
    const heartbeat = heartbeatService(db, { autoStartQueuedRuns: false });

    const dispatch = (issueId: string) =>
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "execution_queue_dispatch",
        payload: { issueId },
        contextSnapshot: { issueId, source: "execution.queue", executionQueueDispatch: true },
      });

    const results = await Promise.all(issueIds.map(dispatch));

    const succeeded = results.filter((result) => result !== null);
    const suppressed = results.filter((result) => result === null);
    expect(succeeded).toHaveLength(1);
    expect(suppressed).toHaveLength(RACER_COUNT - 1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    // Confirms autoStartQueuedRuns: false actually held the run back — this
    // failing would mean the flag isn't doing what this test relies on it for.
    expect(runs[0]?.status).toBe("queued");

    const wipSkips = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, "execution_control.wip_limit"));
    expect(wipSkips).toHaveLength(RACER_COUNT - 1);
  });
});
