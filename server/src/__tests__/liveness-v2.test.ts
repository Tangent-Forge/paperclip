import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, agents, companies, issues, livenessEffectOutbox, livenessIncidents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as livenessObserver from "../services/recovery/liveness-observer";
import * as issuesModule from "../services/issues.js";
import { livenessEffectWorker, reconcileIssueGraphLivenessV2 } from "../services/recovery/liveness-v2";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function finding(overrides: any = {}) {
  const companyId = overrides.companyId ?? randomUUID();
  const issueId = overrides.issueId ?? randomUUID();
  const sourceOriginId = overrides.sourceOriginId ?? `source-${issueId}`;
  return {
    companyId,
    issueId,
    identifier: `ISS-${issueId.slice(0, 8)}`,
    reason: "source issue is stalled",
    severity: "critical",
    state: "blocked",
    recoveryIssueId: overrides.recoveryIssueId ?? null,
    recommendedOwnerAgentId: overrides.recommendedOwnerAgentId ?? null,
    incidentKey: `liveness:${issueId}`,
    sourceProvider: overrides.sourceProvider ?? "linear",
    sourceOriginId,
    incidentClass: "issue_graph_liveness" as const,
    canonicalIdentity: { companyId, provider: overrides.sourceProvider ?? "linear", originId: sourceOriginId, incidentClass: "issue_graph_liveness" as const },
  } as any;
}

async function makeDb() {
  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-liveness-v2-");
  return { db: createDb(tempDb.connectionString), cleanup: tempDb.cleanup };
}

async function seedCompanyDb(db: ReturnType<typeof createDb>, companyId = randomUUID()) {
  const issuePrefix = `T${companyId.slice(0, 4).toUpperCase()}`;
  await db.insert(companies).values({ id: companyId, name: "Test Co", issuePrefix, issueCounter: 0, attachmentMaxBytes: 1_000_000 });
  return companyId;
}

async function seedIssue(db: ReturnType<typeof createDb>, companyId: string, issueId = randomUUID(), extra: Record<string, unknown> = {}) {
  await db.insert(issues).values({ id: issueId, companyId, title: "Source issue", status: "todo", priority: "high", originKind: "manual", originId: null, originFingerprint: "default", ...extra } as any);
  return issueId;
}

afterEach(() => vi.restoreAllMocks());

describeEmbeddedPostgres("liveness v2 reconciler", () => {
  it("is idempotent across repeated reconciliation and opens one wake/effect per generation", { timeout: 30000 }, async () => {
    const { db, cleanup } = await makeDb();
    try {
      const companyId = await seedCompanyDb(db);
      const sourceIssueId = await seedIssue(db, companyId);
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "active", adapterType: "process", adapterConfig: {} as any });
      vi.spyOn(livenessObserver, "observeIssueGraphLiveness").mockResolvedValue([finding({ companyId, issueId: sourceIssueId, recommendedOwnerAgentId: agentId })] as any);
      const wakes: Array<any> = [];
      const deps = { enqueueWakeup: async (agentId: string, opts: any) => { wakes.push({ agentId, opts }); return null; } };
      const first = await reconcileIssueGraphLivenessV2(db, deps, { now: new Date("2026-04-18T12:00:00Z"), presentObservations: 1, observationSpacingMs: 0, absentObservations: 1, recurrenceCooldownMs: 0 });
      const second = await reconcileIssueGraphLivenessV2(db, deps, { now: new Date("2026-04-18T12:00:00Z"), presentObservations: 1, observationSpacingMs: 0, absentObservations: 1, recurrenceCooldownMs: 0 });
      expect(first.activated).toBe(1);
      expect(second.activated).toBe(0);
      const incidents = await db.select().from(livenessIncidents).where(eq(livenessIncidents.companyId, companyId));
      expect(incidents).toHaveLength(1);
      const outbox = await db.select().from(livenessEffectOutbox).where(eq(livenessEffectOutbox.incidentId, incidents[0]!.id));
      expect(outbox.map((row) => row.effectKind).sort()).toEqual(["enqueue_wake", "open_or_reopen_sentinel", "sync_blocker"]);
      expect(wakes).toHaveLength(1);
    } finally { await cleanup(); }
  });

  it("reopens the same sentinel on terminal recurrence and increments generation", { timeout: 30000 }, async () => {
    const { db, cleanup } = await makeDb();
    try {
      const companyId = await seedCompanyDb(db);
      const sourceIssueId = await seedIssue(db, companyId);
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "active", adapterType: "process", adapterConfig: {} as any });
      vi.spyOn(livenessObserver, "observeIssueGraphLiveness").mockResolvedValue([finding({ companyId, issueId: sourceIssueId, recommendedOwnerAgentId: agentId })] as any);
      const deps = { enqueueWakeup: async () => null };
      await reconcileIssueGraphLivenessV2(db, deps, { now: new Date("2026-04-18T12:00:00Z"), presentObservations: 1, observationSpacingMs: 0, absentObservations: 1, recurrenceCooldownMs: 0 });
      const incident = (await db.select().from(livenessIncidents)).at(0)!;
      await db.update(issues).set({ status: "done", completedAt: new Date("2026-04-18T12:01:00Z") }).where(eq(issues.id, incident.sentinelIssueId!));
      await db.update(livenessIncidents).set({ state: "cleared", consecutiveAbsent: 2, nextEligibleAt: new Date("2026-04-18T12:02:00Z") }).where(eq(livenessIncidents.id, incident.id));
      await reconcileIssueGraphLivenessV2(db, deps, { now: new Date("2026-04-18T12:40:00Z"), presentObservations: 1, observationSpacingMs: 0, absentObservations: 1, recurrenceCooldownMs: 0 });
      const reopened = (await db.select().from(livenessIncidents)).at(0)!;
      const sentinel = (await db.select().from(issues).where(eq(issues.id, reopened.sentinelIssueId!))).at(0)!;
      expect(reopened.generation).toBe(2);
      expect(sentinel.status).toBe("todo");
      expect((await db.select().from(issues).where(eq(issues.livenessIncidentId, reopened.id)))).toHaveLength(1);
    } finally { await cleanup(); }
  });

  it("converges duplicate-key open_or_reopen effects onto one sentinel and applies the worker without failure", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const companyId = await seedCompanyDb(db);
      const sourceIssueId = await seedIssue(db, companyId);
      const recoveryIssueId = await seedIssue(db, companyId);
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "active", adapterType: "process", adapterConfig: {} as any });
      vi.spyOn(livenessObserver, "observeIssueGraphLiveness").mockResolvedValue([finding({ companyId, issueId: sourceIssueId, recoveryIssueId, recommendedOwnerAgentId: agentId })] as any);
      const duplicateError = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint: "issues_liveness_incident_uq" });
      const issueServiceStub = {
        create: async (companyIdArg: string, input: any) => {
          const [created] = await db.insert(issues).values({
            companyId: companyIdArg,
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            parentId: input.parentId,
            projectId: input.projectId,
            goalId: input.goalId,
            assigneeAgentId: input.assigneeAgentId,
            originKind: input.originKind,
            originId: input.originId,
            originFingerprint: input.originFingerprint,
            livenessIncidentId: input.livenessIncidentId,
          } as any).returning();
          if (!created) throw new Error("failed to seed winning sentinel");
          return Promise.reject(duplicateError);
        },
        update: async (id: string, input: any) => {
          const [updated] = await db.update(issues).set({ ...input, updatedAt: new Date("2026-04-18T12:00:00Z") } as any).where(eq(issues.id, id)).returning();
          return updated ?? null;
        },
      } as any;
      vi.spyOn(issuesModule, "issueService").mockReturnValue(issueServiceStub);
      const deps = { enqueueWakeup: async () => null };
      const result = await reconcileIssueGraphLivenessV2(db, deps, { now: new Date("2026-04-18T12:00:00Z"), presentObservations: 1, observationSpacingMs: 0, absentObservations: 1, recurrenceCooldownMs: 0 });
      expect(result.failed).toBe(0);
      expect(result.applied).toBeGreaterThan(0);
      const incidents = await db.select().from(livenessIncidents).where(eq(livenessIncidents.companyId, companyId));
      expect(incidents).toHaveLength(1);
      const incident = incidents[0]!;
      const sentinels = await db.select().from(issues).where(eq(issues.livenessIncidentId, incident.id));
      expect(sentinels).toHaveLength(1);
      expect(incident.sentinelIssueId).toBe(sentinels[0]!.id);
      const issueCount = await db.select({ count: sql<number>`count(*)` }).from(issues).where(eq(issues.livenessIncidentId, incident.id));
      expect(Number(issueCount[0]?.count ?? 0)).toBe(1);
      const outbox = await db.select().from(livenessEffectOutbox).where(eq(livenessEffectOutbox.incidentId, incident.id));
      expect(outbox.every((row) => row.status === "applied")).toBe(true);
      expect(outbox.map((row) => row.effectKind).sort()).toEqual(["enqueue_wake", "open_or_reopen_sentinel", "sync_blocker"]);
    } finally {
      vi.restoreAllMocks();
      await cleanup();
    }
  });

  it("retries the outbox after an injected wake failure", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const companyId = await seedCompanyDb(db);
      const sourceIssueId = await seedIssue(db, companyId);
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "active", adapterType: "process", adapterConfig: {} as any });
      vi.spyOn(livenessObserver, "observeIssueGraphLiveness").mockResolvedValue([finding({ companyId, issueId: sourceIssueId, recommendedOwnerAgentId: agentId })] as any);
      let calls = 0;
      const deps = { enqueueWakeup: async () => { calls += 1; if (calls === 1) throw new Error("boom"); return null; } };
      const reconcile = await reconcileIssueGraphLivenessV2(db, deps, { now: new Date("2026-04-18T12:00:00Z"), presentObservations: 1, observationSpacingMs: 0, absentObservations: 1, recurrenceCooldownMs: 0 });
      expect(reconcile.failed).toBeGreaterThan(0);
      const incident = (await db.select().from(livenessIncidents)).at(0)!;
      let outbox = await db.select().from(livenessEffectOutbox).where(eq(livenessEffectOutbox.incidentId, incident.id));
      expect(outbox.some((row) => row.status === "pending")).toBe(true);
      const firstDrain = await livenessEffectWorker(db, deps, { now: new Date("2026-04-18T12:00:05Z") })(10);
      expect(firstDrain.applied).toBeGreaterThan(0);
      outbox = await db.select().from(livenessEffectOutbox).where(eq(livenessEffectOutbox.incidentId, incident.id));
      expect(outbox.every((row) => row.status === "applied")).toBe(true);
      const secondDrain = await livenessEffectWorker(db, deps, { now: new Date("2026-04-18T12:10:01Z") })(10);
      expect(secondDrain.applied).toBe(0);
      outbox = await db.select().from(livenessEffectOutbox).where(eq(livenessEffectOutbox.incidentId, incident.id));
      expect(outbox.every((row) => row.status === "applied")).toBe(true);
    } finally { await cleanup(); }
  });

  it("suppresses recovery-origin findings at the real observer boundary", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const companyId = await seedCompanyDb(db);
      const recoveryIssueId = await seedIssue(db, companyId, randomUUID(), { originKind: "harness_liveness_escalation", originId: "incident-1" });
      await seedIssue(db, companyId, randomUUID(), { originKind: "linear", originId: "SRC-1" });
      const findings = await livenessObserver.observeIssueGraphLiveness(db, new Date("2026-04-18T12:00:00Z"));
      expect(findings.some((f) => f.issueId === recoveryIssueId)).toBe(false);
    } finally { await cleanup(); }
  });

  it("applies per-company backpressure independently", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const companyA = await seedCompanyDb(db);
      const companyB = await seedCompanyDb(db);
      const sourceA = await seedIssue(db, companyA);
      const sourceB = await seedIssue(db, companyB);
      const sourceA2 = await seedIssue(db, companyA);
      vi.spyOn(livenessObserver, "observeIssueGraphLiveness").mockResolvedValue([
        finding({ companyId: companyA, issueId: sourceA, sourceOriginId: "a-1" }),
        finding({ companyId: companyA, issueId: sourceA2, sourceOriginId: "a-2" }),
        finding({ companyId: companyB, issueId: sourceB, sourceOriginId: "b-1" }),
      ] as any);
      const deps = { enqueueWakeup: async () => null };
      const result = await reconcileIssueGraphLivenessV2(db, deps, { now: new Date("2026-04-18T12:00:00Z"), presentObservations: 1, observationSpacingMs: 0, absentObservations: 1, recurrenceCooldownMs: 0, maxActivationsPerCompany: 1 });
      expect(result.activated).toBe(2);
      expect(result.suppressed).toBe(1);
      const incidentStates = await db.select({ companyId: livenessIncidents.companyId, state: livenessIncidents.state }).from(livenessIncidents);
      expect(incidentStates.filter((row) => row.companyId === companyA && row.state === "suppressed")).toHaveLength(1);
      expect(incidentStates.filter((row) => row.companyId === companyB && row.state === "active")).toHaveLength(1);
    } finally { await cleanup(); }
  });
});
