CREATE TABLE IF NOT EXISTS "evidence_owners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "owner_type" text DEFAULT 'unknown' NOT NULL,
  "external_id" text,
  "contact_ref" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_authorities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "authority_type" text DEFAULT 'unknown' NOT NULL,
  "jurisdiction" text,
  "external_id" text,
  "url" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "owner_id" uuid REFERENCES "public"."evidence_owners"("id") ON DELETE set null,
  "authority_id" uuid REFERENCES "public"."evidence_authorities"("id") ON DELETE set null,
  "source_type" text NOT NULL,
  "title" text NOT NULL,
  "locator" text NOT NULL,
  "canonical_url" text,
  "retrieved_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE set null,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "source_id" uuid REFERENCES "public"."evidence_sources"("id") ON DELETE set null,
  "issue_id" uuid REFERENCES "public"."issues"("id") ON DELETE set null,
  "asset_id" uuid REFERENCES "public"."assets"("id") ON DELETE set null,
  "document_id" uuid REFERENCES "public"."documents"("id") ON DELETE set null,
  "document_revision_id" uuid REFERENCES "public"."document_revisions"("id") ON DELETE set null,
  "work_product_id" uuid REFERENCES "public"."issue_work_products"("id") ON DELETE set null,
  "artifact_type" text NOT NULL,
  "title" text NOT NULL,
  "mime_type" text,
  "storage_ref" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_datasets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "owner_id" uuid REFERENCES "public"."evidence_owners"("id") ON DELETE set null,
  "authority_id" uuid REFERENCES "public"."evidence_authorities"("id") ON DELETE set null,
  "source_id" uuid REFERENCES "public"."evidence_sources"("id") ON DELETE set null,
  "name" text NOT NULL,
  "version" text,
  "license" text,
  "locator" text,
  "schema_json" jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_extractions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "source_id" uuid REFERENCES "public"."evidence_sources"("id") ON DELETE set null,
  "artifact_id" uuid REFERENCES "public"."evidence_artifacts"("id") ON DELETE set null,
  "dataset_id" uuid REFERENCES "public"."evidence_datasets"("id") ON DELETE set null,
  "extracted_by_agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE set null,
  "extracted_by_run_id" uuid REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null,
  "method" text NOT NULL,
  "locator" text,
  "raw_text" text,
  "normalized_json" jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "source_id" uuid REFERENCES "public"."evidence_sources"("id") ON DELETE set null,
  "artifact_id" uuid REFERENCES "public"."evidence_artifacts"("id") ON DELETE set null,
  "extraction_id" uuid REFERENCES "public"."evidence_extractions"("id") ON DELETE set null,
  "dataset_id" uuid REFERENCES "public"."evidence_datasets"("id") ON DELETE set null,
  "owner_id" uuid REFERENCES "public"."evidence_owners"("id") ON DELETE set null,
  "authority_id" uuid REFERENCES "public"."evidence_authorities"("id") ON DELETE set null,
  "claim_type" text DEFAULT 'statement' NOT NULL,
  "subject" text,
  "predicate" text,
  "object" text,
  "statement" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_date_ranges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "target_kind" text NOT NULL,
  "target_id" uuid NOT NULL,
  "range_type" text DEFAULT 'validity' NOT NULL,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "precision" text DEFAULT 'instant' NOT NULL,
  "timezone" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_hashes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "target_kind" text NOT NULL,
  "target_id" uuid NOT NULL,
  "algorithm" text DEFAULT 'sha256' NOT NULL,
  "value" text NOT NULL,
  "scope" text DEFAULT 'content' NOT NULL,
  "byte_size" integer,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_lineage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "from_kind" text NOT NULL,
  "from_id" uuid NOT NULL,
  "to_kind" text NOT NULL,
  "to_id" uuid NOT NULL,
  "relation_type" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_confidence_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "target_kind" text NOT NULL,
  "target_id" uuid NOT NULL,
  "score" integer NOT NULL,
  "method" text DEFAULT 'manual' NOT NULL,
  "rationale" text,
  "created_by_agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE set null,
  "created_by_run_id" uuid REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_contradictions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "subject_claim_id" uuid NOT NULL REFERENCES "public"."evidence_claims"("id") ON DELETE cascade,
  "object_claim_id" uuid NOT NULL REFERENCES "public"."evidence_claims"("id") ON DELETE cascade,
  "contradiction_type" text DEFAULT 'conflict' NOT NULL,
  "severity" text DEFAULT 'medium' NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "rationale" text,
  "detected_by_agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE set null,
  "detected_by_run_id" uuid REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_dispositions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "target_kind" text NOT NULL,
  "target_id" uuid NOT NULL,
  "disposition" text NOT NULL,
  "reason" text,
  "supersedes_disposition_id" uuid,
  "decided_by_agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE set null,
  "decided_by_run_id" uuid REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null,
  "decided_by_user_id" text,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_owners_company_name_idx" ON "evidence_owners" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_owners_company_external_id_uq" ON "evidence_owners" USING btree ("company_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_authorities_company_name_idx" ON "evidence_authorities" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_authorities_company_external_id_uq" ON "evidence_authorities" USING btree ("company_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_sources_company_type_idx" ON "evidence_sources" USING btree ("company_id","source_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_sources_company_owner_idx" ON "evidence_sources" USING btree ("company_id","owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_sources_company_authority_idx" ON "evidence_sources" USING btree ("company_id","authority_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_sources_company_locator_uq" ON "evidence_sources" USING btree ("company_id","locator");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_artifacts_company_source_idx" ON "evidence_artifacts" USING btree ("company_id","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_artifacts_company_issue_idx" ON "evidence_artifacts" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_artifacts_company_asset_idx" ON "evidence_artifacts" USING btree ("company_id","asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_artifacts_company_document_idx" ON "evidence_artifacts" USING btree ("company_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_artifacts_company_work_product_idx" ON "evidence_artifacts" USING btree ("company_id","work_product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_datasets_company_name_idx" ON "evidence_datasets" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_datasets_company_source_idx" ON "evidence_datasets" USING btree ("company_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_datasets_company_locator_uq" ON "evidence_datasets" USING btree ("company_id","locator");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_extractions_company_source_idx" ON "evidence_extractions" USING btree ("company_id","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_extractions_company_artifact_idx" ON "evidence_extractions" USING btree ("company_id","artifact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_extractions_company_dataset_idx" ON "evidence_extractions" USING btree ("company_id","dataset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_extractions_company_run_idx" ON "evidence_extractions" USING btree ("company_id","extracted_by_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_claims_company_source_idx" ON "evidence_claims" USING btree ("company_id","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_claims_company_artifact_idx" ON "evidence_claims" USING btree ("company_id","artifact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_claims_company_extraction_idx" ON "evidence_claims" USING btree ("company_id","extraction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_claims_company_dataset_idx" ON "evidence_claims" USING btree ("company_id","dataset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_claims_company_subject_idx" ON "evidence_claims" USING btree ("company_id","subject");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_claims_company_status_idx" ON "evidence_claims" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_date_ranges_company_target_idx" ON "evidence_date_ranges" USING btree ("company_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_date_ranges_company_range_type_idx" ON "evidence_date_ranges" USING btree ("company_id","range_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_hashes_company_target_idx" ON "evidence_hashes" USING btree ("company_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_hashes_company_algorithm_value_idx" ON "evidence_hashes" USING btree ("company_id","algorithm","value");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_hashes_company_target_hash_uq" ON "evidence_hashes" USING btree ("company_id","target_kind","target_id","algorithm","value","scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_lineage_company_from_idx" ON "evidence_lineage" USING btree ("company_id","from_kind","from_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_lineage_company_to_idx" ON "evidence_lineage" USING btree ("company_id","to_kind","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_lineage_company_edge_uq" ON "evidence_lineage" USING btree ("company_id","from_kind","from_id","to_kind","to_id","relation_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_confidence_scores_company_target_idx" ON "evidence_confidence_scores" USING btree ("company_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_confidence_scores_company_method_idx" ON "evidence_confidence_scores" USING btree ("company_id","method");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_contradictions_company_subject_idx" ON "evidence_contradictions" USING btree ("company_id","subject_claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_contradictions_company_object_idx" ON "evidence_contradictions" USING btree ("company_id","object_claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_contradictions_company_status_idx" ON "evidence_contradictions" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_contradictions_company_claim_pair_uq" ON "evidence_contradictions" USING btree ("company_id","subject_claim_id","object_claim_id","contradiction_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_dispositions_company_target_idx" ON "evidence_dispositions" USING btree ("company_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_dispositions_company_disposition_idx" ON "evidence_dispositions" USING btree ("company_id","disposition");
