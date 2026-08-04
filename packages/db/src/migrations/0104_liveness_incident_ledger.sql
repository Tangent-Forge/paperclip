-- Durable liveness incident ledger and supersession registry.

CREATE TABLE IF NOT EXISTS "liveness_reconcile_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "status" text NOT NULL,
  "disposition" text,
  "observed_count" integer DEFAULT 0 NOT NULL,
  "activated_count" integer DEFAULT 0 NOT NULL,
  "cleared_count" integer DEFAULT 0 NOT NULL,
  "effect_count" integer DEFAULT 0 NOT NULL,
  "error_summary" text,
  CONSTRAINT "liveness_reconcile_runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed')),
  CONSTRAINT "liveness_reconcile_runs_disposition_check" CHECK ("disposition" IS NULL OR "disposition" IN ('no_change', 'effects_applied', 'failed')),
  CONSTRAINT "liveness_reconcile_runs_observed_count_check" CHECK ("observed_count" >= 0),
  CONSTRAINT "liveness_reconcile_runs_activated_count_check" CHECK ("activated_count" >= 0),
  CONSTRAINT "liveness_reconcile_runs_cleared_count_check" CHECK ("cleared_count" >= 0),
  CONSTRAINT "liveness_reconcile_runs_effect_count_check" CHECK ("effect_count" >= 0),
  CONSTRAINT "liveness_reconcile_runs_terminal_disposition_check"
    CHECK (("liveness_reconcile_runs"."status" = 'running' AND "liveness_reconcile_runs"."disposition" IS NULL AND "liveness_reconcile_runs"."completed_at" IS NULL)
      OR ("liveness_reconcile_runs"."status" <> 'running' AND "liveness_reconcile_runs"."disposition" IS NOT NULL AND "liveness_reconcile_runs"."completed_at" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "liveness_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "source_provider" text NOT NULL,
  "source_origin_id" text NOT NULL,
  "source_issue_id" uuid,
  "incident_class" text NOT NULL,
  "state" text NOT NULL DEFAULT 'observed',
  "generation" integer NOT NULL DEFAULT 1,
  "consecutive_present" integer NOT NULL DEFAULT 0,
  "consecutive_absent" integer NOT NULL DEFAULT 0,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "activated_at" timestamp with time zone,
  "cleared_at" timestamp with time zone,
  "next_eligible_at" timestamp with time zone,
  "sentinel_issue_id" uuid,
  "last_reconcile_run_id" uuid,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "liveness_incidents_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "liveness_incidents_consecutive_present_check" CHECK ("consecutive_present" >= 0),
  CONSTRAINT "liveness_incidents_consecutive_absent_check" CHECK ("consecutive_absent" >= 0),
  CONSTRAINT "liveness_incidents_state_check" CHECK ("state" IN ('observed', 'active', 'clearing', 'cleared', 'suppressed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "liveness_incidents_canonical_uq"
  ON "liveness_incidents" ("company_id", "source_provider", "source_origin_id", "incident_class");

CREATE UNIQUE INDEX IF NOT EXISTS "liveness_incidents_sentinel_issue_uq"
  ON "liveness_incidents" ("sentinel_issue_id")
  WHERE "sentinel_issue_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "liveness_incidents_due_idx"
  ON "liveness_incidents" ("state", "next_eligible_at");

ALTER TABLE "liveness_incidents"
  ADD CONSTRAINT "liveness_incidents_source_issue_id_issues_id_fk"
  FOREIGN KEY ("source_issue_id") REFERENCES "issues"("id") ON DELETE SET NULL;

ALTER TABLE "liveness_incidents"
  ADD CONSTRAINT "liveness_incidents_sentinel_issue_id_issues_id_fk"
  FOREIGN KEY ("sentinel_issue_id") REFERENCES "issues"("id") ON DELETE SET NULL;

ALTER TABLE "liveness_incidents"
  ADD CONSTRAINT "liveness_incidents_last_reconcile_run_id_liveness_reconcile_runs_id_fk"
  FOREIGN KEY ("last_reconcile_run_id") REFERENCES "liveness_reconcile_runs"("id") ON DELETE SET NULL;

ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "liveness_incident_id" uuid;

ALTER TABLE "issues"
  ADD CONSTRAINT "issues_liveness_incident_id_liveness_incidents_id_fk"
  FOREIGN KEY ("liveness_incident_id") REFERENCES "liveness_incidents"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "issues_liveness_incident_uq"
  ON "issues" ("liveness_incident_id")
  WHERE "origin_kind" = 'harness_liveness_escalation'
    AND "liveness_incident_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "liveness_effect_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "incident_id" uuid NOT NULL REFERENCES "liveness_incidents"("id"),
  "generation" integer NOT NULL,
  "effect_kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "liveness_effect_outbox_status_check" CHECK ("status" IN ('pending', 'processing', 'applied', 'failed')),
  CONSTRAINT "liveness_effect_outbox_effect_kind_check" CHECK ("effect_kind" IN ('open_or_reopen_sentinel', 'close_sentinel', 'sync_blocker', 'enqueue_wake')),
  CONSTRAINT "liveness_effect_outbox_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "liveness_effect_outbox_attempt_count_check" CHECK ("attempt_count" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "liveness_effect_outbox_incident_generation_effect_kind_uq"
  ON "liveness_effect_outbox" ("incident_id", "generation", "effect_kind");

CREATE TABLE IF NOT EXISTS "liveness_sentinel_supersessions" (
  "duplicate_issue_id" uuid PRIMARY KEY REFERENCES "issues"("id"),
  "canonical_issue_id" uuid NOT NULL REFERENCES "issues"("id"),
  "incident_id" uuid NOT NULL REFERENCES "liveness_incidents"("id"),
  "reason" text NOT NULL DEFAULT 'historical_duplicate',
  "audit_manifest_sha256" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "liveness_sentinel_supersessions_duplicate_not_canonical_check" CHECK ("duplicate_issue_id" <> "canonical_issue_id")
);
