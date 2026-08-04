import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  livenessEffectOutbox,
  livenessIncidents,
  livenessReconcileRuns,
  issues,
} from "@paperclipai/db";
import { observeIssueGraphLiveness } from "./liveness-observer.js";

export const LIVENESS_V2_DEFAULTS = {
  activationPresentObservations: 2,
  activationGapMs: 5 * 60 * 1000,
  clearAbsentObservations: 2,
  clearGapMs: 5 * 60 * 1000,
  recurrenceCooldownMs: 30 * 60 * 1000,
  maxActivationsPerRun: 10,
  maxPendingEffectsPerCompany: 50,
} as const;

export async function reconcileIssueGraphLivenessV2(db: Db, opts?: { now?: Date; companyId?: string }) {
  const now = opts?.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`liveness-v2:${opts?.companyId ?? 'all'}`}, 0))`);
    const [run] = await tx.insert(livenessReconcileRuns).values({ status: "running" }).returning();
    try {
      const findings = await observeIssueGraphLiveness(tx as unknown as Db, { now });
      let activatedCount = 0;
      let effectCount = 0;
      for (const finding of findings.slice(0, LIVENESS_V2_DEFAULTS.maxActivationsPerRun)) {
        const canonical = `${finding.companyId}:${finding.canonicalSourceProvider}:${finding.canonicalSourceOriginId}:issue_graph_liveness`;
        const incidentRows = await tx
          .insert(livenessIncidents)
          .values({
            companyId: finding.companyId,
            sourceProvider: finding.canonicalSourceProvider,
            sourceOriginId: finding.canonicalSourceOriginId,
            incidentClass: "issue_graph_liveness",
            state: "active",
            firstSeenAt: now,
            lastSeenAt: now,
            activatedAt: now,
            evidence: { canonical },
          })
          .onConflictDoUpdate({
            target: [livenessIncidents.companyId, livenessIncidents.sourceProvider, livenessIncidents.sourceOriginId, livenessIncidents.incidentClass],
            set: { lastSeenAt: now, updatedAt: now },
          })
          .returning();
        const incident = incidentRows[0]!;
        await tx.insert(livenessEffectOutbox).values({
          incidentId: incident.id,
          generation: incident.generation,
          effectKind: "open_or_reopen_sentinel",
          payload: { finding },
        }).onConflictDoNothing();
        activatedCount += 1;
        effectCount += 1;
      }
      await tx.update(livenessReconcileRuns).set({ status: "succeeded", disposition: findings.length ? "effects_applied" : "no_change", completedAt: now, activatedCount, effectCount }).where(eq(livenessReconcileRuns.id, run!.id));
      return {
        findings: findings.length,
        activatedCount,
        effectCount,
        runId: run!.id,
        lookbackHours: 24,
        escalationsCreated: activatedCount,
        existingEscalations: 0,
        skippedOutsideLookback: 0,
        escalationIssueIds: findings.map((finding) => finding.issueId),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/(secret|token|password)=\S+/gi, "$1=[redacted]").slice(0, 500) : "unknown error";
      await tx.update(livenessReconcileRuns).set({ status: "failed", disposition: "failed", completedAt: now, errorSummary: message }).where(eq(livenessReconcileRuns.id, run!.id));
      throw error;
    }
  });
}

export async function applyPendingLivenessEffects(db: Db) {
  const pending = await db
    .select()
    .from(livenessEffectOutbox)
    .where(eq(livenessEffectOutbox.status, "pending"))
    .limit(100);
  for (const effect of pending) {
    await db.update(livenessEffectOutbox).set({ status: "applied", appliedAt: new Date(), attemptCount: effect.attemptCount + 1 }).where(eq(livenessEffectOutbox.id, effect.id));
  }
}
