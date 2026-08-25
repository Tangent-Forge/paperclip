CREATE TABLE "delivery_worker_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"authorized_by_user_id" text NOT NULL,
	"revoked_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_worker_activations_status_check" CHECK ("delivery_worker_activations"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "delivery_candidates" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_candidates" ADD COLUMN "failure_classification" text;--> statement-breakpoint
ALTER TABLE "delivery_candidates" ADD COLUMN "next_retry_earliest_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_route_contracts" ADD COLUMN "auto_retry_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_route_contracts" ADD COLUMN "retry_backoff_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_candidates" ADD CONSTRAINT "delivery_candidates_failure_classification_check" CHECK ("delivery_candidates"."failure_classification" is null or "delivery_candidates"."failure_classification" in ('transient', 'permanent'));