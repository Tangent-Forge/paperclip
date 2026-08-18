-- Enforce one active wakeup per (company, agent, idempotency_key).
-- First collapse any accidental duplicate active rows, keeping the oldest.
DO $$
DECLARE
  deleted_count integer;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY company_id, agent_id, idempotency_key
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM agent_wakeup_requests
    WHERE idempotency_key IS NOT NULL
      AND status IN ('queued', 'deferred_issue_execution', 'claimed')
  ),
  deleted AS (
    UPDATE agent_wakeup_requests
    SET
      status = 'coalesced',
      finished_at = COALESCE(finished_at, now()),
      error = COALESCE(error, 'Collapsed duplicate active idempotency key before unique index'),
      updated_at = now()
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM deleted;

  IF deleted_count > 0 THEN
    RAISE NOTICE 'agent_wakeup_requests_active_idempotency_uq collapsed % duplicate active wake(s)', deleted_count;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_active_idempotency_uq"
  ON "agent_wakeup_requests" ("company_id", "agent_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL
    AND "status" IN ('queued', 'deferred_issue_execution', 'claimed');
