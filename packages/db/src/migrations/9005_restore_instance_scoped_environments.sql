-- A local-only repair migration briefly restored company-scoped environments
-- after canonical migration 0105 had moved environments to instance scope.
-- Re-assert the canonical shape with forward-only, idempotent DDL. The
-- historical migration row remains in the journal and is recognized by the
-- migration compatibility overlay; this migration repairs only schema state.
DROP INDEX IF EXISTS "environments_company_managed_sandbox_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_driver_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_name_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_status_idx";--> statement-breakpoint
ALTER TABLE "environments"
  DROP CONSTRAINT IF EXISTS "environments_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "environments"
  DROP COLUMN IF EXISTS "company_id";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_status_idx"
  ON "environments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_local_driver_idx"
  ON "environments" USING btree ("driver")
  WHERE "driver" = 'local';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_managed_sandbox_idx"
  ON "environments" USING btree ("driver")
  WHERE "driver" = 'sandbox' AND ("metadata" ->> 'managedByPaperclip')::boolean = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_name_idx"
  ON "environments" USING btree ("name");
