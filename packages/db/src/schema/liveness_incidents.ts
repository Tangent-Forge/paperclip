import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const livenessReconcileRuns = pgTable(
  "liveness_reconcile_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").notNull().$type<"running" | "succeeded" | "failed">(),
    disposition: text("disposition").$type<"no_change" | "effects_applied" | "failed">(),
    observedCount: integer("observed_count").notNull().default(0),
    activatedCount: integer("activated_count").notNull().default(0),
    clearedCount: integer("cleared_count").notNull().default(0),
    effectCount: integer("effect_count").notNull().default(0),
    errorSummary: text("error_summary"),
  },
  (table) => ({
    statusCheck: check(
      "liveness_reconcile_runs_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed')`,
    ),
    dispositionCheck: check(
      "liveness_reconcile_runs_disposition_check",
      sql`${table.disposition} is null or ${table.disposition} in ('no_change', 'effects_applied', 'failed')`,
    ),
    observedCountCheck: check("liveness_reconcile_runs_observed_count_check", sql`${table.observedCount} >= 0`),
    activatedCountCheck: check("liveness_reconcile_runs_activated_count_check", sql`${table.activatedCount} >= 0`),
    clearedCountCheck: check("liveness_reconcile_runs_cleared_count_check", sql`${table.clearedCount} >= 0`),
    effectCountCheck: check("liveness_reconcile_runs_effect_count_check", sql`${table.effectCount} >= 0`),
    terminalDispositionCheck: check(
      "liveness_reconcile_runs_terminal_disposition_check",
      sql`(
        (${table.status} = 'running' and ${table.disposition} is null and ${table.completedAt} is null)
        or
        (${table.status} <> 'running' and ${table.disposition} is not null and ${table.completedAt} is not null)
      )`,
    ),
  }),
);

export const livenessIncidents = pgTable(
  "liveness_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceProvider: text("source_provider").notNull(),
    sourceOriginId: text("source_origin_id").notNull(),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    incidentClass: text("incident_class").notNull(),
    state: text("state").notNull().default("observed").$type<
      "observed" | "active" | "clearing" | "cleared" | "suppressed"
    >(),
    generation: integer("generation").notNull().default(1),
    consecutivePresent: integer("consecutive_present").notNull().default(0),
    consecutiveAbsent: integer("consecutive_absent").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
    sentinelIssueId: uuid("sentinel_issue_id").references(() => issues.id, { onDelete: "set null" }),
    lastReconcileRunId: uuid("last_reconcile_run_id").references(() => livenessReconcileRuns.id, {
      onDelete: "set null",
    }),
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    canonicalUq: uniqueIndex("liveness_incidents_canonical_uq").on(
      table.companyId,
      table.sourceProvider,
      table.sourceOriginId,
      table.incidentClass,
    ),
    sentinelIssueUq: uniqueIndex("liveness_incidents_sentinel_issue_uq")
      .on(table.sentinelIssueId)
      .where(sql`${table.sentinelIssueId} is not null`),
    dueIdx: index("liveness_incidents_due_idx").on(table.state, table.nextEligibleAt),
    generationCheck: check("liveness_incidents_generation_check", sql`${table.generation} > 0`),
    consecutivePresentCheck: check(
      "liveness_incidents_consecutive_present_check",
      sql`${table.consecutivePresent} >= 0`,
    ),
    consecutiveAbsentCheck: check(
      "liveness_incidents_consecutive_absent_check",
      sql`${table.consecutiveAbsent} >= 0`,
    ),
    stateCheck: check(
      "liveness_incidents_state_check",
      sql`${table.state} in ('observed', 'active', 'clearing', 'cleared', 'suppressed')`,
    ),
  }),
);

export const livenessEffectOutbox = pgTable(
  "liveness_effect_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id").notNull().references(() => livenessIncidents.id),
    generation: integer("generation").notNull(),
    effectKind: text("effect_kind").notNull().$type<
      "open_or_reopen_sentinel" | "close_sentinel" | "sync_blocker" | "enqueue_wake"
    >(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending").$type<"pending" | "processing" | "applied" | "failed">(),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueEffect: uniqueIndex("liveness_effect_outbox_incident_generation_effect_kind_uq").on(
      table.incidentId,
      table.generation,
      table.effectKind,
    ),
    statusCheck: check(
      "liveness_effect_outbox_status_check",
      sql`${table.status} in ('pending', 'processing', 'applied', 'failed')`,
    ),
    effectKindCheck: check(
      "liveness_effect_outbox_effect_kind_check",
      sql`${table.effectKind} in ('open_or_reopen_sentinel', 'close_sentinel', 'sync_blocker', 'enqueue_wake')`,
    ),
    generationCheck: check("liveness_effect_outbox_generation_check", sql`${table.generation} > 0`),
    attemptCountCheck: check("liveness_effect_outbox_attempt_count_check", sql`${table.attemptCount} >= 0`),
  }),
);

export const livenessSentinelSupersessions = pgTable(
  "liveness_sentinel_supersessions",
  {
    duplicateIssueId: uuid("duplicate_issue_id").primaryKey().references(() => issues.id),
    canonicalIssueId: uuid("canonical_issue_id").notNull().references(() => issues.id),
    incidentId: uuid("incident_id").notNull().references(() => livenessIncidents.id),
    reason: text("reason").notNull().default("historical_duplicate"),
    auditManifestSha256: text("audit_manifest_sha256").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    selfMapCheck: check(
      "liveness_sentinel_supersessions_duplicate_not_canonical_check",
      sql`${table.duplicateIssueId} <> ${table.canonicalIssueId}`,
    ),
  }),
);
