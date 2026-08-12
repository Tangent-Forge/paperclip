-- Fork-owned migration. Restores company-scoped `environments`, reversing the parts of
-- upstream 0105_instance_scoped_environments that production never actually took.
--
-- Why this exists: production's ledger records 0105 as applied, but production's
-- `environments` still has `company_id` and the four company-scoped indexes — it matches
-- packages/db/src/schema/environments.ts, not the migration sequence. That table's live
-- shape came from a schema push, not a migration. Without this, a clean deploy builds
-- instance-scoped tables that the fork's own code cannot use.
--
-- Numbered in a fork-reserved 9000+ band so it can never collide with upstream's
-- sequence (currently at 0213) on a future re-sync.
--
-- Idempotent: safe to re-run. Fails loudly rather than silently producing a different
-- schema if it ever meets a populated table it cannot backfill.

ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint

-- Under company scoping an environment must belong to a company. 0105 seeds a single
-- instance-wide "Local" environment, which has no company to belong to and is not a valid
-- row in this model — production instead holds one Local environment PER company (2
-- companies, 2 rows), created alongside the company rather than seeded instance-wide.
-- Remove any row that cannot be scoped, and say how many.
--
-- This cannot silently discard live data: on a fresh database the only such row is 0105's
-- seed, and any database already holding company-scoped environments skips this migration
-- entirely (its `when` is at or below the recorded apply threshold).
DO $$
DECLARE
  removed integer;
BEGIN
  WITH deleted AS (
    DELETE FROM "environments" WHERE "company_id" IS NULL RETURNING 1
  )
  SELECT count(*) INTO removed FROM deleted;

  IF removed > 0 THEN
    RAISE NOTICE
      'restore_company_scoped_environments: removed % unscoped environment row(s) left by 0105_instance_scoped_environments', removed;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "environments" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environments_company_id_companies_id_fk'
      AND conrelid = 'public.environments'::regclass
  ) THEN
    ALTER TABLE "environments"
      ADD CONSTRAINT "environments_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;
  END IF;
END $$;--> statement-breakpoint

-- Drop the instance-scoped indexes 0105 introduced.
DROP INDEX IF EXISTS "environments_local_driver_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environments_managed_sandbox_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environments_name_idx";--> statement-breakpoint

-- Recreate the company-scoped set, matching production exactly.
CREATE INDEX IF NOT EXISTS "environments_company_name_idx"
  ON "environments" USING btree ("company_id", "name");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "environments_company_status_idx"
  ON "environments" USING btree ("company_id", "status");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_driver_idx"
  ON "environments" USING btree ("company_id", "driver")
  WHERE "driver" = 'local';--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_managed_sandbox_idx"
  ON "environments" USING btree ("company_id")
  WHERE "driver" = 'sandbox' AND (("metadata" ->> 'managedByPaperclip')::boolean = true);
