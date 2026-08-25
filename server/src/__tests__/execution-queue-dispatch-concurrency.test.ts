import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
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
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { executionQueueRoutes } from "../routes/execution-queue.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution queue dispatch concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Proves the atomic-dispatch redesign at the level it actually matters: real
// HTTP requests, hitting the real route, racing on the real database — not a
// direct service-function call, and not a stubbed wakeup(). This is what
// "produces one truthful dispatch record per selected issue" means in
// practice: every `disposition: "queued"` response must correspond to exactly
// one real, uniquely-owned heartbeat_runs row, and the WIP limit must hold
// exactly, even when far more requests race than there is capacity for.
describeEmbeddedPostgres("execution queue dispatch-next — concurrent route-level safety", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-queue-dispatch-concurrency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests, and
    // activity_log references heartbeat_runs — children before parents.
    await db.delete(activityLog);
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

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    // autoStartAfterDispatch:false — the reservation (selection + lock + run
    // creation) is the real, unstubbed implementation being tested; only the
    // post-commit "start it for real" step, which needs an adapter this
    // fixture has none of, is skipped, for the same determinism reason as
    // heartbeat.ts's autoStartQueuedRuns.
    app.use("/api", executionQueueRoutes(db, { autoStartAfterDispatch: false }));
    app.use(errorHandler);
    return app;
  }

  async function seedRaceableCompany(input: { issueCount: number; maxActiveRunsPerAgent: number }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Dispatch race co",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: {
        executionQueueMode: "controlled",
        executionQueueMaxActiveRunsPerAgent: input.maxActiveRunsPerAgent,
      },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Race worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    const issueIds = Array.from({ length: input.issueCount }, () => randomUUID());
    await db.insert(issues).values(
      issueIds.map((id, index) => ({
        id,
        companyId,
        title: `Race issue ${index}`,
        identifier: `E-${index + 1}`,
        status: "todo" as const,
        priority: "high" as const,
        assigneeAgentId: agentId,
      })),
    );
    return { companyId, agentId, issueIds };
  }

  it("under N simultaneous route-level dispatch requests, exactly maxActiveRunsPerAgent succeed and every success is a real, unique run", async () => {
    const REQUEST_COUNT = 10;
    const MAX_ACTIVE = 3;
    const { companyId, agentId, issueIds } = await seedRaceableCompany({
      issueCount: REQUEST_COUNT,
      maxActiveRunsPerAgent: MAX_ACTIVE,
    });
    const app = createApp();

    const responses = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () =>
        request(app).post(`/api/companies/${companyId}/execution-queue/dispatch-next`).send()),
    );

    const bodies = responses.map((res) => {
      expect(res.status).toBe(200);
      return res.body as { disposition: string; issueId: string | null; runId: string | null };
    });
    const queued = bodies.filter((body) => body.disposition === "queued");
    const notDispatched = bodies.filter((body) => body.disposition === "not_dispatched");

    expect(queued).toHaveLength(MAX_ACTIVE);
    expect(notDispatched).toHaveLength(REQUEST_COUNT - MAX_ACTIVE);

    // Every queued response names a real, distinct issue from the seeded set —
    // not a duplicate, not something outside what was actually offered.
    const dispatchedIssueIds = queued.map((body) => body.issueId);
    expect(new Set(dispatchedIssueIds).size).toBe(MAX_ACTIVE);
    for (const issueId of dispatchedIssueIds) {
      expect(issueIds).toContain(issueId);
    }

    // Every queued response's runId is truthful: a real row exists, it's
    // unique, and it actually references the issue the response claims.
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(MAX_ACTIVE);
    const runIssueIdByRunId = new Map(
      runs.map((run) => [run.id, (run.contextSnapshot as Record<string, unknown> | null)?.issueId]),
    );
    for (const body of queued) {
      expect(runIssueIdByRunId.get(body.runId!)).toBe(body.issueId);
    }
    // No two runs claim the same issue, and no issue was claimed by more than
    // one run — the exact defect this redesign closes.
    const issueIdsOnRuns = [...runIssueIdByRunId.values()];
    expect(new Set(issueIdsOnRuns).size).toBe(issueIdsOnRuns.length);
  });

  it("under simultaneous requests with capacity for only one, exactly one issue is dispatched — never zero, never two", async () => {
    const REQUEST_COUNT = 8;
    const { companyId, agentId, issueIds } = await seedRaceableCompany({
      issueCount: REQUEST_COUNT,
      maxActiveRunsPerAgent: 1,
    });
    const app = createApp();

    const responses = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () =>
        request(app).post(`/api/companies/${companyId}/execution-queue/dispatch-next`).send()),
    );
    const bodies = responses.map((res) => {
      expect(res.status).toBe(200);
      return res.body as { disposition: string; issueId: string | null; runId: string | null };
    });
    const queued = bodies.filter((body) => body.disposition === "queued");

    expect(queued).toHaveLength(1);
    expect(issueIds).toContain(queued[0]?.issueId);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect((runs[0]?.contextSnapshot as Record<string, unknown> | null)?.issueId).toBe(queued[0]?.issueId);
  });
});
