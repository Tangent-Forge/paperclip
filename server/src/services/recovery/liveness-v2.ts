import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issueRelations, issues, livenessEffectOutbox, livenessIncidents, livenessReconcileRuns } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { logActivity } from "../activity-log.js";
import type { CanonicalLivenessFinding } from "./liveness-observer.js";
import * as livenessObserver from "./liveness-observer.js";
import { RECOVERY_ORIGIN_KINDS } from "./origins.js";

export type LivenessV2Options = {
  now?: Date;
  autoRecoveryEnabled?: boolean;
  lookbackHours?: number;
  presentObservations?: number;
  absentObservations?: number;
  observationSpacingMs?: number;
  recurrenceCooldownMs?: number;
  maxActivationsPerCompany?: number;
  maxPendingEffectsPerCompany?: number;
  effectMaxAttempts?: number;
  canaryCompanyId?: string | null;
};

const DEFAULTS = { presentObservations: 2, absentObservations: 2, observationSpacingMs: 5 * 60_000, recurrenceCooldownMs: 30 * 60_000, maxActivationsPerCompany: 10, maxPendingEffectsPerCompany: 50, effectMaxAttempts: 3 } as const;
const INCIDENT_CLASS = "issue_graph_liveness" as const;
const TERMINAL = ["done", "cancelled"] as const;

function bounded(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function options(input?: LivenessV2Options) {
  return {
    now: input?.now && !Number.isNaN(input.now.getTime()) ? new Date(input.now) : new Date(),
    autoRecoveryEnabled: input?.autoRecoveryEnabled ?? true,
    lookbackHours: bounded(input?.lookbackHours, 24, 0, 168),
    presentObservations: bounded(input?.presentObservations, DEFAULTS.presentObservations, 1, 10),
    absentObservations: bounded(input?.absentObservations, DEFAULTS.absentObservations, 1, 10),
    observationSpacingMs: bounded(input?.observationSpacingMs, DEFAULTS.observationSpacingMs, 1_000, 24 * 60 * 60_000),
    recurrenceCooldownMs: bounded(input?.recurrenceCooldownMs, DEFAULTS.recurrenceCooldownMs, 0, 7 * 24 * 60 * 60_000),
    maxActivationsPerCompany: bounded(input?.maxActivationsPerCompany, DEFAULTS.maxActivationsPerCompany, 1, 100),
    maxPendingEffectsPerCompany: bounded(input?.maxPendingEffectsPerCompany, DEFAULTS.maxPendingEffectsPerCompany, 1, 1_000),
    effectMaxAttempts: bounded(input?.effectMaxAttempts, DEFAULTS.effectMaxAttempts, 1, 10),
    canaryCompanyId: input?.canaryCompanyId ?? process.env.PAPERCLIP_LIVENESS_V2_CANARY_COMPANY_ID ?? null,
  };
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
}

function isUniqueConstraintViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const constraint = (error as { constraint?: unknown }).constraint;
  return code === "23505" || constraint === "issues_liveness_incident_uq";
}

function identityJson(finding: CanonicalLivenessFinding) {
  return JSON.stringify({ companyId: finding.companyId, provider: finding.sourceProvider, originId: finding.sourceOriginId, incidentClass: INCIDENT_CLASS });
}

function fingerprint(finding: CanonicalLivenessFinding) {
  return `sentinel:v2:${createHash("sha256").update(identityJson(finding)).digest("hex")}`;
}

function effectPayload(finding: CanonicalLivenessFinding) {
  return { finding, sourceIssueId: finding.issueId, recoveryIssueId: finding.recoveryIssueId, ownerAgentId: finding.recommendedOwnerAgentId };
}

async function enqueueEffect(tx: any, incidentId: string, generation: number, effectKind: "open_or_reopen_sentinel" | "close_sentinel" | "sync_blocker" | "enqueue_wake", payload: unknown, availableAt: Date) {
  await tx.insert(livenessEffectOutbox).values({ incidentId, generation, effectKind, payload, availableAt }).onConflictDoNothing({ target: [livenessEffectOutbox.incidentId, livenessEffectOutbox.generation, livenessEffectOutbox.effectKind] });
}

async function reconcileCompany(db: Db, companyId: string, findings: CanonicalLivenessFinding[], runId: string, cfg: ReturnType<typeof options>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`liveness-v2:${companyId}`}, 0))`);
    const now = cfg.now;
    const companyFindings = findings.filter((f) => f.companyId === companyId);
    const existing = (await tx.select().from(livenessIncidents).where(and(eq(livenessIncidents.companyId, companyId), eq(livenessIncidents.incidentClass, INCIDENT_CLASS)))) as any[];
    const byKey = new Map<string, any>(existing.map((row) => [`${row.sourceProvider}\0${row.sourceOriginId}`, row]));
    let activated = 0, cleared = 0, effects = 0, suppressed = 0;
    const currentKeys = new Set<string>();
    for (const finding of companyFindings) {
      const key = `${finding.sourceProvider}\0${finding.sourceOriginId}`;
      currentKeys.add(key);
      const prior = byKey.get(key);
      if (!prior) {
        const shouldActivateNow = cfg.presentObservations <= 1;
        const [created] = await tx
          .insert(livenessIncidents)
          .values({
            companyId,
            sourceProvider: finding.sourceProvider,
            sourceOriginId: finding.sourceOriginId,
            sourceIssueId: finding.issueId,
            incidentClass: INCIDENT_CLASS,
            state: shouldActivateNow && activated < cfg.maxActivationsPerCompany ? "active" : shouldActivateNow ? "suppressed" : "observed",
            generation: 1,
            consecutivePresent: 1,
            consecutiveAbsent: 0,
            firstSeenAt: now,
            lastSeenAt: now,
            activatedAt: shouldActivateNow ? now : null,
            lastReconcileRunId: runId,
            evidence: effectPayload(finding),
          })
          .onConflictDoNothing({
            target: [
              livenessIncidents.companyId,
              livenessIncidents.sourceProvider,
              livenessIncidents.sourceOriginId,
              livenessIncidents.incidentClass,
            ],
          })
          .returning();
        const incident = created ?? await tx.select().from(livenessIncidents).where(and(eq(livenessIncidents.companyId, companyId), eq(livenessIncidents.sourceProvider, finding.sourceProvider), eq(livenessIncidents.sourceOriginId, finding.sourceOriginId), eq(livenessIncidents.incidentClass, INCIDENT_CLASS))).then((rows) => rows[0] ?? null);
        if (incident) {
          byKey.set(key, incident);
          if (shouldActivateNow && incident.state === "active") {
            await enqueueEffect(tx, incident.id, incident.generation, "open_or_reopen_sentinel", effectPayload(finding), now);
            await enqueueEffect(tx, incident.id, incident.generation, "sync_blocker", effectPayload(finding), now);
            await enqueueEffect(tx, incident.id, incident.generation, "enqueue_wake", effectPayload(finding), now);
            activated += 1;
            effects += 3;
          } else if (shouldActivateNow) {
            suppressed += 1;
          }
        }
        continue;
      }
      const spaced = now.getTime() - prior.lastSeenAt.getTime() >= cfg.observationSpacingMs;
      const shouldActivate = prior.state !== "active" && prior.state !== "suppressed" && spaced && prior.consecutivePresent + 1 >= cfg.presentObservations && (!prior.nextEligibleAt || now >= prior.nextEligibleAt);
      const nextGeneration = shouldActivate && prior.state === "cleared" ? prior.generation + 1 : prior.generation;
      const pendingCount = (await tx.select({ count: sql<number>`count(*)` }).from(livenessEffectOutbox).innerJoin(livenessIncidents, eq(livenessEffectOutbox.incidentId, livenessIncidents.id)).where(and(eq(livenessIncidents.companyId, companyId), inArray(livenessEffectOutbox.status, ["pending", "processing"]))))[0]?.count ?? 0;
      const overCap = shouldActivate && (activated >= cfg.maxActivationsPerCompany || pendingCount >= cfg.maxPendingEffectsPerCompany);
      if (overCap) { suppressed += 1; await tx.update(livenessIncidents).set({ state: "suppressed", consecutivePresent: prior.consecutivePresent + (spaced ? 1 : 0), consecutiveAbsent: 0, lastSeenAt: now, updatedAt: now, lastReconcileRunId: runId, evidence: effectPayload(finding) }).where(eq(livenessIncidents.id, prior.id)); continue; }
      if (shouldActivate) {
        activated += 1;
        await tx.update(livenessIncidents).set({ state: "active", generation: nextGeneration, consecutivePresent: prior.consecutivePresent + 1, consecutiveAbsent: 0, lastSeenAt: now, activatedAt: now, clearedAt: null, nextEligibleAt: null, sourceIssueId: finding.issueId, updatedAt: now, lastReconcileRunId: runId, evidence: effectPayload(finding) }).where(eq(livenessIncidents.id, prior.id));
        await enqueueEffect(tx, prior.id, nextGeneration, "open_or_reopen_sentinel", effectPayload(finding), now);
        await enqueueEffect(tx, prior.id, nextGeneration, "sync_blocker", effectPayload(finding), now);
        await enqueueEffect(tx, prior.id, nextGeneration, "enqueue_wake", effectPayload(finding), now);
        effects += 3;
      } else {
        await tx.update(livenessIncidents).set({ consecutivePresent: spaced ? prior.consecutivePresent + 1 : prior.consecutivePresent, consecutiveAbsent: 0, lastSeenAt: now, sourceIssueId: finding.issueId, updatedAt: now, lastReconcileRunId: runId, evidence: effectPayload(finding) }).where(eq(livenessIncidents.id, prior.id));
      }
    }
    for (const prior of existing) {
      if (currentKeys.has(`${prior.sourceProvider}\0${prior.sourceOriginId}`) || prior.state === "cleared") continue;
      const spaced = now.getTime() - prior.lastSeenAt.getTime() >= cfg.observationSpacingMs;
      const absent = spaced ? prior.consecutiveAbsent + 1 : prior.consecutiveAbsent;
      if (absent >= cfg.absentObservations) {
        cleared += 1;
        await tx.update(livenessIncidents).set({ state: "cleared", consecutiveAbsent: absent, consecutivePresent: 0, clearedAt: now, nextEligibleAt: new Date(now.getTime() + cfg.recurrenceCooldownMs), updatedAt: now, lastReconcileRunId: runId }).where(eq(livenessIncidents.id, prior.id));
        await enqueueEffect(tx, prior.id, prior.generation, "close_sentinel", prior.evidence, now);
        effects += 1;
      } else {
        await tx.update(livenessIncidents).set({ state: prior.state === "observed" ? "observed" : "clearing", consecutiveAbsent: absent, consecutivePresent: 0, updatedAt: now, lastReconcileRunId: runId }).where(eq(livenessIncidents.id, prior.id));
      }
    }
    return { activated, cleared, effects, suppressed };
  });
}

async function claimEffect(db: Db, now: Date) {
  return db.transaction(async (tx) => {
    const row = await tx.select({ effect: livenessEffectOutbox, incident: livenessIncidents }).from(livenessEffectOutbox).innerJoin(livenessIncidents, eq(livenessEffectOutbox.incidentId, livenessIncidents.id)).where(and(inArray(livenessEffectOutbox.status, ["pending", "processing"]), lte(livenessEffectOutbox.availableAt, now))).orderBy(asc(livenessEffectOutbox.createdAt)).limit(1).for("update", { skipLocked: true }).then((rows) => rows[0] ?? null);
    if (!row) return null;
    await tx.update(livenessEffectOutbox).set({ status: "processing", attemptCount: row.effect.attemptCount + 1, updatedAt: now }).where(eq(livenessEffectOutbox.id, row.effect.id));
    return row;
  });
}

export function livenessEffectWorker(db: Db, deps: { enqueueWakeup: (agentId: string, opts: any) => Promise<unknown> }, cfgInput?: LivenessV2Options) {
  const cfg = options(cfgInput);
  const issuesSvc = issueService(db);
  return async function drain(limit = 100) {
    let applied = 0, failed = 0;
    for (let i = 0; i < Math.min(100, Math.max(0, limit)); i += 1) {
      const claimed = await claimEffect(db, cfg.now);
      if (!claimed) break;
      if (cfg.canaryCompanyId !== null && cfg.canaryCompanyId !== claimed.incident.companyId) {
        await db.update(livenessEffectOutbox).set({ status: "failed", lastError: "canary company gate", updatedAt: cfg.now }).where(eq(livenessEffectOutbox.id, claimed.effect.id));
        failed += 1; continue;
      }
      try {
        const payload = (claimed.effect.payload ?? {}) as { finding?: CanonicalLivenessFinding; sourceIssueId?: string; recoveryIssueId?: string; ownerAgentId?: string | null };
        const finding = payload.finding;
        let sentinel = await db.select().from(issues).where(eq(issues.livenessIncidentId, claimed.incident.id)).then((rows) => rows[0] ?? null);
        if (claimed.effect.effectKind === "open_or_reopen_sentinel" && finding) {
          if (!sentinel) {
            const recovery = await db.select().from(issues).where(and(eq(issues.id, finding.recoveryIssueId), eq(issues.companyId, claimed.incident.companyId))).then((rows) => rows[0] ?? null);
            try {
              const created = await issuesSvc.create(claimed.incident.companyId, { title: `Unblock liveness incident for ${finding.identifier ?? finding.issueId}`, description: finding.reason, status: "todo", priority: "high", parentId: recovery?.id ?? null, projectId: recovery?.projectId ?? null, goalId: recovery?.goalId ?? null, assigneeAgentId: finding.recommendedOwnerAgentId, originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation, originId: claimed.incident.id, originFingerprint: fingerprint(finding), livenessIncidentId: claimed.incident.id });
              sentinel = created;
              await db.update(livenessIncidents).set({ sentinelIssueId: created.id, updatedAt: cfg.now }).where(eq(livenessIncidents.id, claimed.incident.id));
            } catch (error) {
              if (!isUniqueConstraintViolation(error)) throw error;
              const racedSentinel = await db.select().from(issues).where(and(eq(issues.companyId, claimed.incident.companyId), eq(issues.livenessIncidentId, claimed.incident.id))).then((rows) => rows[0] ?? null);
              if (!racedSentinel) throw error;
              sentinel = racedSentinel;
              await db.update(livenessIncidents).set({ sentinelIssueId: racedSentinel.id, updatedAt: cfg.now }).where(eq(livenessIncidents.id, claimed.incident.id));
            }
          } else if (TERMINAL.includes(sentinel.status as (typeof TERMINAL)[number])) {
            await issuesSvc.update(sentinel.id, { status: "todo", cancelledAt: null, completedAt: null });
          }
        } else if (claimed.effect.effectKind === "sync_blocker" && sentinel && finding) {
          const source = await db.select().from(issues).where(eq(issues.id, finding.issueId)).then((rows) => rows[0] ?? null);
          if (source && !TERMINAL.includes(sentinel.status as (typeof TERMINAL)[number])) {
            const blockers = await db.select({ id: issueRelations.issueId }).from(issueRelations).where(and(eq(issueRelations.companyId, source.companyId), eq(issueRelations.relatedIssueId, source.id), eq(issueRelations.type, "blocks")));
            await issuesSvc.update(source.id, { blockedByIssueIds: [...new Set([...blockers.map((b) => b.id), sentinel.id])] });
          }
        } else if (claimed.effect.effectKind === "close_sentinel" && sentinel) {
          await issuesSvc.update(sentinel.id, { status: "done", blockedByIssueIds: [] });
          if (finding) {
            const source = await db.select().from(issues).where(eq(issues.id, finding.issueId)).then((rows) => rows[0] ?? null);
            if (source) {
              const blockers = await db.select({ id: issueRelations.issueId }).from(issueRelations).where(and(eq(issueRelations.companyId, source.companyId), eq(issueRelations.relatedIssueId, source.id), eq(issueRelations.type, "blocks")));
              await issuesSvc.update(source.id, { blockedByIssueIds: blockers.map((b) => b.id).filter((id) => id !== sentinel.id) });
            }
          }
        } else if (claimed.effect.effectKind === "enqueue_wake" && sentinel && finding && !TERMINAL.includes(sentinel.status as (typeof TERMINAL)[number]) && finding.recommendedOwnerAgentId) {
          await deps.enqueueWakeup(finding.recommendedOwnerAgentId, { source: "automation", triggerDetail: "system", reason: "liveness_v2", idempotencyKey: `liveness-v2:${claimed.incident.id}:${claimed.effect.generation}:wake`, contextSnapshot: { issueId: sentinel.id } });
        }
        await db.update(livenessEffectOutbox).set({ status: "applied", appliedAt: cfg.now, updatedAt: cfg.now, lastError: null }).where(eq(livenessEffectOutbox.id, claimed.effect.id));
        applied += 1;
      } catch (error) {
        failed += 1;
        const attempts = claimed.effect.attemptCount;
        await db.update(livenessEffectOutbox).set({ status: attempts >= cfg.effectMaxAttempts ? "failed" : "pending", availableAt: new Date(cfg.now.getTime() + Math.min(60_000, 1_000 * 2 ** attempts)), lastError: safeError(error), updatedAt: cfg.now }).where(eq(livenessEffectOutbox.id, claimed.effect.id));
      }
    }
    return { applied, failed };
  };
}

export async function reconcileIssueGraphLivenessV2(db: Db, deps: { enqueueWakeup: (agentId: string, opts: any) => Promise<unknown> }, input?: LivenessV2Options) {
  const cfg = options(input);
  const findings = await livenessObserver.observeIssueGraphLiveness(db, cfg.now);
  const cutoff = new Date(cfg.now.getTime() - cfg.lookbackHours * 60 * 60_000);
  const withinLookback = findings.filter((finding) => !finding.sourceIssueUpdatedAt || finding.sourceIssueUpdatedAt >= cutoff);
  const skippedOutsideLookback = findings.length - withinLookback.length;
  if (!cfg.autoRecoveryEnabled) {
    return {
      findings: findings.length,
      autoRecoveryEnabled: false,
      lookbackHours: cfg.lookbackHours,
      cutoff: cutoff.toISOString(),
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: findings.length,
      skippedAutoRecoveryDisabled: findings.length,
      skippedOutsideLookback,
      obsoleteRecoveriesRetired: 0,
      obsoleteRecoveriesActiveSkipped: 0,
      obsoleteRecoveryBlockerRelationsRemoved: 0,
      doneRecoveryBlockerRelationsRemoved: 0,
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      retiredRecoveryIssueIds: [] as string[],
      runId: null,
      activated: 0,
      cleared: 0,
      effects: 0,
      suppressed: 0,
      applied: 0,
      failed: 0,
    };
  }
  const [run] = await db.insert(livenessReconcileRuns).values({ status: "running", startedAt: cfg.now }).returning();
  if (!run) throw new Error("failed to create liveness reconcile run");
  try {
    const companyIds = [...new Set(withinLookback.map((f) => f.companyId))];
    const existingCompanies = await db.select({ companyId: livenessIncidents.companyId }).from(livenessIncidents);
    for (const id of existingCompanies.map((r) => r.companyId)) if (!companyIds.includes(id)) companyIds.push(id);
    let activated = 0, cleared = 0, effects = 0, suppressed = 0;
    for (const companyId of companyIds) { const result = await reconcileCompany(db, companyId, withinLookback, run.id, cfg); activated += result.activated; cleared += result.cleared; effects += result.effects; suppressed += result.suppressed; }
    const worker = livenessEffectWorker(db, deps, cfg);
    const applied = await worker();
    const disposition = effects || applied.applied ? "effects_applied" : "no_change";
    await db.update(livenessReconcileRuns).set({ status: "succeeded", disposition, completedAt: cfg.now, observedCount: withinLookback.length, activatedCount: activated, clearedCount: cleared, effectCount: effects, errorSummary: suppressed ? `suppressed:${suppressed}` : null }).where(eq(livenessReconcileRuns.id, run.id));
    return {
      findings: findings.length,
      activated,
      cleared,
      effects,
      suppressed,
      runId: run.id,
      ...applied,
      autoRecoveryEnabled: true,
      lookbackHours: cfg.lookbackHours,
      cutoff: cutoff.toISOString(),
      escalationsCreated: activated,
      existingEscalations: 0,
      skipped: skippedOutsideLookback,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback,
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      obsoleteRecoveriesRetired: 0,
      obsoleteRecoveriesActiveSkipped: 0,
      obsoleteRecoveryBlockerRelationsRemoved: 0,
      doneRecoveryBlockerRelationsRemoved: 0,
      retiredRecoveryIssueIds: [] as string[],
    };
  } catch (error) {
    await db.update(livenessReconcileRuns).set({ status: "failed", disposition: "failed", completedAt: cfg.now, errorSummary: safeError(error) }).where(eq(livenessReconcileRuns.id, run.id));
    throw error;
  }
}
