import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
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
    `Skipping execution queue dispatch-freshness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Covers the two gaps identified in the atomic-dispatch redesign review:
//
// 1. The candidate scan used to be a single fixed LIMIT 25 lookahead — a run
//    of 25+ ineligible top-ranked issues could permanently hide an eligible
//    issue below them and falsely report "No runnable issue is available."
//    dispatchNext() now keyset-paginates across pages until it finds a
//    dispatchable issue or genuinely exhausts the candidate set.
//
// 2. Eligibility (budget/WIP/tree-hold) used to be snapshotted once, BEFORE
//    the claim transaction began, and reused for the whole call — a mutation
//    landing in the gap between that snapshot and the transaction actually
//    starting was invisible to candidate selection. dispatchNext() now
//    (re)computes eligibility from inside the claim transaction itself.
describeEmbeddedPostgres("execution queue dispatchNext — unbounded scan and in-transaction freshness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-queue-dispatch-freshness-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests, so
    // runs must be deleted first — dispatchNext's real (unstubbed) wakeup()
    // links the two, unlike a bare test fixture row.
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("finds and dispatches the 26th-ranked issue when the top 25 are all ineligible, instead of falsely reporting no runnable work", async () => {
    const companyId = randomUUID();
    const blockedAgentId = randomUUID();
    const readyAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Lookahead Co",
      issuePrefix: "LKA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { executionQueueMode: "controlled", executionQueueMaxActiveRunsPerAgent: 1 },
    });
    await db.insert(agents).values([
      {
        id: blockedAgentId,
        companyId,
        name: "WIP-saturated agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
      {
        id: readyAgentId,
        companyId,
        name: "Ready agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    // One pre-existing active run puts blockedAgentId at its WIP cap of 1
    // before dispatchNext ever runs — every issue assigned to it is
    // classified waiting:agent_wip_limit, never runnable.
    await db.insert(heartbeatRuns).values({ companyId, agentId: blockedAgentId, status: "queued" });

    // 25 issues, all higher-ranked (critical) than the eligible one, all
    // assigned to the WIP-saturated agent — exactly the old fixed-25
    // lookahead's page size, so the old implementation would examine every
    // one of these and stop, having never looked further.
    const ineligibleIssues = Array.from({ length: 25 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      title: `Ineligible ${index}`,
      identifier: `LKA-${index + 1}`,
      status: "todo" as const,
      priority: "critical" as const,
      assigneeAgentId: blockedAgentId,
    }));
    await db.insert(issues).values(ineligibleIssues);

    // The 26th-ranked candidate: lower priority so it always sorts after all
    // 25 ineligible issues, assigned to a clean agent with spare capacity.
    const eligibleIssueId = randomUUID();
    await db.insert(issues).values({
      id: eligibleIssueId,
      companyId,
      title: "Eligible but ranked 26th",
      identifier: "LKA-26",
      status: "todo",
      priority: "low",
      assigneeAgentId: readyAgentId,
    });

    const queue = executionQueueService(db, { autoStartAfterDispatch: false });
    const result = await queue.dispatchNext(companyId);

    expect(result).toMatchObject({ disposition: "queued", issueId: eligibleIssueId });
    expect(result.runId).toBeTruthy();

    // The dispatch is truthful: a real run exists for the ready agent
    // referencing exactly this issue, and the WIP-saturated agent's run
    // count never changed — none of the 25 ineligible issues were touched.
    const readyRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, readyAgentId));
    expect(readyRuns).toHaveLength(1);
    expect(readyRuns[0]?.id).toBe(result.runId);
    expect((readyRuns[0]?.contextSnapshot as Record<string, unknown> | null)?.issueId).toBe(eligibleIssueId);

    const blockedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, blockedAgentId));
    expect(blockedRuns).toHaveLength(1);
  });

  it("honors a budget hard-stop committed after the pre-transaction gap but before the claim, instead of dispatching (or crashing) on stale eligibility", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Freshness Co",
      issuePrefix: "FRS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { executionQueueMode: "controlled", executionQueueMaxActiveRunsPerAgent: 5 },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Soon-to-be-blocked agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Not yet budget-blocked",
      identifier: "FRS-1",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    // A separate connection, not the one dispatchNext() runs on — mirrors a
    // genuinely concurrent request/process committing the budget block, not
    // a step of dispatchNext's own transaction.
    const mutatorDb = createDb(tempDb!.connectionString);
    try {
      const queue = executionQueueService(db, {
        autoStartAfterDispatch: false,
        // Fires once, right before dispatchNext's claim transaction begins —
        // exactly the "snapshot taken (if computed early), claim not yet
        // made" window a pre-transaction eligibility snapshot would have
        // missed entirely.
        beforeClaimTransactionForTest: async () => {
          await mutatorDb.insert(budgetPolicies).values({
            companyId,
            scopeType: "agent",
            scopeId: agentId,
            metric: "billed_cents",
            windowKind: "calendar_month_utc",
            amount: 100,
            hardStopEnabled: true,
            isActive: true,
          });
          await mutatorDb.insert(costEvents).values({
            companyId,
            agentId,
            provider: "anthropic",
            model: "test-model",
            costCents: 150,
            occurredAt: new Date(),
          });
        },
      });

      // Must resolve gracefully — not reject — even though the only
      // candidate becomes budget-blocked in the exact gap this test targets.
      await expect(queue.dispatchNext(companyId)).resolves.toMatchObject({
        disposition: "not_dispatched",
        issueId: null,
        runId: null,
      });

      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(0);
    } finally {
      await mutatorDb.$client.end();
    }
  });

  it("advances past a run of issues tied on BOTH priority and updatedAt, relying solely on the id tiebreak, and still finds the eligible one among them", async () => {
    const companyId = randomUUID();
    const blockedAgentId = randomUUID();
    const readyAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Tiebreak Co",
      issuePrefix: "TIE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { executionQueueMode: "controlled", executionQueueMaxActiveRunsPerAgent: 1 },
    });
    await db.insert(agents).values([
      {
        id: blockedAgentId,
        companyId,
        name: "WIP-saturated agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
      {
        id: readyAgentId,
        companyId,
        name: "Ready agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({ companyId, agentId: blockedAgentId, status: "queued" });

    const TIE_COUNT = 30;
    // The maximum possible uuid — guarantees the eligible issue always sorts
    // strictly last among the 31 tied rows (ascending id is the final ORDER
    // BY / cursor tiebreak key), so it always lands on page 2, regardless of
    // what random ids the other 30 rows happen to get. Without pinning this,
    // the eligible issue's page depends on random id ordering — it lands on
    // page 1 (where it'd be found trivially, without ever exercising the
    // cursor's tiebreak-by-id clause) roughly 25/31 of the time, making the
    // test's pass/fail non-deterministic and, most of the time, not actually
    // prove anything about pagination.
    const eligibleIssueId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    // Every row below gets the SAME priority, and (below, via raw SQL) the
    // SAME updatedAt down to the microsecond — not the same millisecond.
    // Postgres timestamptz carries microsecond precision; a JS Date can only
    // hold milliseconds, so seeding through a JS Date value — even one with
    // ".000" milliseconds — can never actually recreate the bug: there is no
    // sub-millisecond digit left for a Date round-trip to lose, so a broken
    // (Date-truncating) cursor implementation would pass this test by
    // accident. Setting updated_at directly via SQL to a literal with a
    // genuine non-zero microsecond component (".000123", not ".000000")
    // closes that gap: only an implementation that carries the value through
    // as raw text — the actual fix — can compare it correctly.
    await db.insert(issues).values([
      ...Array.from({ length: TIE_COUNT }, (_, index) => ({
        id: randomUUID(),
        companyId,
        title: `Tied ineligible ${index}`,
        identifier: `TIE-${index + 1}`,
        status: "todo" as const,
        priority: "critical" as const,
        assigneeAgentId: blockedAgentId,
      })),
      {
        id: eligibleIssueId,
        companyId,
        title: "Tied but eligible",
        identifier: `TIE-${TIE_COUNT + 1}`,
        status: "todo" as const,
        priority: "critical" as const,
        assigneeAgentId: readyAgentId,
      },
    ]);
    await db.execute(
      sql`update ${issues} set updated_at = '2026-01-01T00:00:00.000123Z'::timestamptz where ${issues.companyId} = ${companyId}`,
    );

    // Sanity check on the seed itself, not on dispatchNext: confirms Postgres
    // actually retained the microseconds (so a false pass here couldn't be
    // masked by Postgres itself rounding the literal down), and that every
    // one of the 31 rows genuinely ties on it — the test's own precondition,
    // verified rather than assumed.
    const seededTimestamps = await db.execute<{ updated_at: string }>(
      sql`select distinct updated_at::text from ${issues} where ${issues.companyId} = ${companyId}`,
    );
    expect(seededTimestamps).toHaveLength(1);
    expect(String(seededTimestamps[0]?.updated_at)).toContain(".000123");

    const queue = executionQueueService(db, { autoStartAfterDispatch: false });
    const result = await queue.dispatchNext(companyId);

    expect(result).toMatchObject({ disposition: "queued", issueId: eligibleIssueId });
    expect(result.runId).toBeTruthy();

    // Truthful and exclusive: exactly one real run for the ready agent,
    // referencing the eligible issue — none of the 30 tied ineligible issues
    // were ever touched, despite being fully indistinguishable from it on
    // priority and updatedAt.
    const readyRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, readyAgentId));
    expect(readyRuns).toHaveLength(1);
    expect(readyRuns[0]?.id).toBe(result.runId);
    const blockedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, blockedAgentId));
    expect(blockedRuns).toHaveLength(1);
  });

  it("reports selection_incomplete, not a false not_dispatched, when the scan exhausts its 500-candidate bound before ever reaching a genuinely eligible issue", async () => {
    const companyId = randomUUID();
    const blockedAgentId = randomUUID();
    const readyAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Scan Limit Co",
      issuePrefix: "LIM",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { executionQueueMode: "controlled", executionQueueMaxActiveRunsPerAgent: 1 },
    });
    await db.insert(agents).values([
      {
        id: blockedAgentId,
        companyId,
        name: "WIP-saturated agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
      {
        id: readyAgentId,
        companyId,
        name: "Ready agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({ companyId, agentId: blockedAgentId, status: "queued" });

    // dispatchNext()'s hard per-request scan bound (DISPATCH_CANDIDATE_SCAN_LIMIT
    // in execution-queue.ts) — asserted here as a literal, matching how the
    // 25-page-size lookahead test above asserts its own bound literally.
    const SCAN_LIMIT = 500;
    const eligibleIssueId = randomUUID();
    // Exactly SCAN_LIMIT ineligible issues, all ranked ahead of the one
    // eligible issue (critical vs. low priority) — the scan will examine
    // exactly this many candidates, hit its bound, and never even reach the
    // eligible issue ranked just past it.
    await db.insert(issues).values(
      Array.from({ length: SCAN_LIMIT }, (_, index) => ({
        id: randomUUID(),
        companyId,
        title: `Beyond-limit ineligible ${index}`,
        identifier: `LIM-${index + 1}`,
        status: "todo" as const,
        priority: "critical" as const,
        assigneeAgentId: blockedAgentId,
      })),
    );
    await db.insert(issues).values({
      id: eligibleIssueId,
      companyId,
      title: "Eligible but ranked past the scan bound",
      identifier: `LIM-${SCAN_LIMIT + 1}`,
      status: "todo",
      priority: "low",
      assigneeAgentId: readyAgentId,
    });

    const queue = executionQueueService(db, { autoStartAfterDispatch: false });
    const result = await queue.dispatchNext(companyId);

    // Not "queued" (the scan never reaches the eligible issue) and, more to
    // the point, not the OLD false "not_dispatched" either — real runnable
    // work exists, the scan just didn't get far enough this request to prove
    // that. selection_incomplete is the honest, retryable answer.
    expect(result.disposition).toBe("selection_incomplete");
    expect(result.issueId).toBeNull();
    expect(result.runId).toBeNull();
    expect(result.reason).toContain("500");

    const readyRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, readyAgentId));
    expect(readyRuns).toHaveLength(0);
  }, 30_000);
});
