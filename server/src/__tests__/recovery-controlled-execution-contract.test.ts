import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery/controlled-execution contract tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The intended rule: in controlled mode, only the execution queue may start
// `todo` work. Recovery may identify stranded/failed work — its scanning and
// escalation-to-`blocked` behavior are untouched — but its dispatch attempts
// must be suppressed exactly like any other non-queue wake, and it must not
// misreport a suppressed attempt as a successful dispatch.
//
// recoveryService here is wired with `enqueueWakeup: heartbeat.wakeup` — the
// same production wiring as routes/agents.ts and heartbeat.ts's own internal
// instance — so this exercises the real, single chokepoint, not a test double.
describeEmbeddedPostgres("recovery scanner respects the controlled-execution queue contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-controlled-contract-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests, so runs
    // must go first — the real wakeup() path (unlike hand-inserted fixtures) links
    // the two, and deleting parent-before-child trips the FK constraint.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(mode: "observe" | "controlled") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Contract Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: {
        executionQueueMode: mode,
        executionQueueMaxActiveRunsPerAgent: 1,
      },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Recovery-owned agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      // wakeOnDemand:true so recovery's non-timer dispatch reaches the
      // controlled-mode gate instead of being rejected earlier for an
      // unrelated reason (heartbeat.wakeOnDemand.disabled).
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedNeverRunTodoIssue(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Never-run assigned todo",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "R-1",
    });
    return issueId;
  }

  async function seedFailedRunIssue(companyId: string, agentId: string, status: "todo" | "in_progress") {
    const issueId = randomUUID();
    const runId = randomUUID();
    // heartbeat_runs has no FK to issues (contextSnapshot is plain jsonb), but
    // issues.checkout_run_id DOES reference heartbeat_runs — so the run must be
    // inserted before an issue that points at it as its checkout run.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      errorCode: "process_lost",
      error: "run failed before issue advanced",
      contextSnapshot: { issueId, taskId: issueId },
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Stranded ${status} work`,
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: status === "in_progress" ? runId : null,
      issueNumber: 1,
      identifier: "R-1",
    });
    return { issueId, runId };
  }

  it("suppresses the initial dispatch of a never-run assigned todo issue in controlled mode", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("controlled");
    const issueId = await seedNeverRunTodoIssue(companyId, agentId);
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.assignmentDispatched).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.issueIds).toEqual([]);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("todo");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("skipped");
    expect(wakes[0]?.reason).toBe("execution_control.queue_required");
  });

  it("still dispatches the same never-run todo issue normally in observe mode (positive control)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("observe");
    await seedNeverRunTodoIssue(companyId, agentId);
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.assignmentDispatched).toBe(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    // A real dispatch was created and is on the execution path — the exact status
    // (queued vs. already picked up as running) isn't the point of this control.
    expect(["queued", "running", "scheduled_retry"]).toContain(runs[0]?.status);
  });

  it("suppresses the todo-branch retry of a failed assigned todo issue in controlled mode", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("controlled");
    const { issueId } = await seedFailedRunIssue(companyId, agentId, "todo");
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.dispatchRequeued).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    // Only the original failed run — no new "queued" retry run was created.
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("todo");
  });

  it("does not gate in_progress continuation recovery — controlled mode only restricts todo work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("controlled");
    await seedFailedRunIssue(companyId, agentId, "in_progress");
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(1);
    expect(result.skipped).toBe(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.some((run) => ["queued", "running", "scheduled_retry"].includes(run.status))).toBe(true);
  });
});
