CREATE TABLE "operational_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"fresh_until" timestamp with time zone NOT NULL,
	"provenance" jsonb NOT NULL,
	"observation" jsonb NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_status_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"fingerprint" text NOT NULL,
	"receipt_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipt_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_at" timestamp with time zone,
	"fresh_until" timestamp with time zone,
	"changed" boolean NOT NULL,
	"summary_required" boolean NOT NULL,
	"summary" text,
	"exception_issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "kind" text DEFAULT 'issues' NOT NULL;--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "operational_config" jsonb;--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "operational_state" text;--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "operational_fingerprint" text;--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "operational_failure_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "operational_recovery_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "operational_latest_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "operational_exception_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "status_cards" ADD COLUMN "operational_summary" text;--> statement-breakpoint
ALTER TABLE "operational_receipts" ADD CONSTRAINT "operational_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_receipts" ADD CONSTRAINT "operational_receipts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_receipts" ADD CONSTRAINT "operational_receipts_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_status_claims" ADD CONSTRAINT "operational_status_claims_card_id_status_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."status_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_status_claims" ADD CONSTRAINT "operational_status_claims_exception_issue_id_issues_id_fk" FOREIGN KEY ("exception_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operational_receipts_latest_evidence_idx" ON "operational_receipts" USING btree ("company_id","source_key","subject_key","observed_at");--> statement-breakpoint
CREATE INDEX "operational_status_claims_card_created_idx" ON "operational_status_claims" USING btree ("card_id","created_at");--> statement-breakpoint
ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_operational_exception_issue_id_issues_id_fk" FOREIGN KEY ("operational_exception_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
