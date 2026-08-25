CREATE TABLE "delivery_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"sha" text NOT NULL,
	"source_worktree_path" text NOT NULL,
	"source_artifact_path" text NOT NULL,
	"source_artifact_captured_at" timestamp with time zone NOT NULL,
	"validation_receipt" jsonb NOT NULL,
	"state" text DEFAULT 'candidate_verified' NOT NULL,
	"blocked_reason" text,
	"route_contract_id" uuid,
	"lease_attempt_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"lease_owner" text,
	"pr_url" text,
	"pr_number" integer,
	"remote_branch_verified_at" timestamp with time zone,
	"pr_verified_at" timestamp with time zone,
	"submitted_by_actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_candidates_state_check" CHECK ("delivery_candidates"."state" in ('candidate_verified', 'publication_authorized', 'publication_blocked', 'publishing', 'publish_failed', 'pr_opened', 'merge_authorized', 'observe_deploy', 'live_verified', 'controlled_activation_authorized', 'accepted'))
);
--> statement-breakpoint
CREATE TABLE "delivery_route_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"branch_pattern" text NOT NULL,
	"base_branch" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"authorized_by_user_id" text NOT NULL,
	"revoked_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_route_contracts_status_check" CHECK ("delivery_route_contracts"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "delivery_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"evidence" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_transitions_to_state_check" CHECK ("delivery_transitions"."to_state" in ('candidate_verified', 'publication_authorized', 'publication_blocked', 'publishing', 'publish_failed', 'pr_opened', 'merge_authorized', 'observe_deploy', 'live_verified', 'controlled_activation_authorized', 'accepted')),
	CONSTRAINT "delivery_transitions_from_state_check" CHECK ("delivery_transitions"."from_state" is null or "delivery_transitions"."from_state" in ('candidate_verified', 'publication_authorized', 'publication_blocked', 'publishing', 'publish_failed', 'pr_opened', 'merge_authorized', 'observe_deploy', 'live_verified', 'controlled_activation_authorized', 'accepted'))
);
--> statement-breakpoint
ALTER TABLE "delivery_candidates" ADD CONSTRAINT "delivery_candidates_route_contract_id_delivery_route_contracts_id_fk" FOREIGN KEY ("route_contract_id") REFERENCES "public"."delivery_route_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_transitions" ADD CONSTRAINT "delivery_transitions_candidate_id_delivery_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."delivery_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_candidates_repo_sha_uq" ON "delivery_candidates" USING btree ("repo","sha");--> statement-breakpoint
CREATE INDEX "delivery_candidates_state_idx" ON "delivery_candidates" USING btree ("state");--> statement-breakpoint
CREATE INDEX "delivery_route_contracts_lookup_idx" ON "delivery_route_contracts" USING btree ("repo","branch_pattern","base_branch","action","status");--> statement-breakpoint
CREATE INDEX "delivery_transitions_candidate_occurred_idx" ON "delivery_transitions" USING btree ("candidate_id","occurred_at");