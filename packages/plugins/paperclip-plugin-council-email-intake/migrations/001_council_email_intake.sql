CREATE TABLE IF NOT EXISTS email_links (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  source_message_id text NOT NULL,
  source_thread_id text,
  paperclip_issue_id uuid,
  subject text,
  sender text,
  received_at timestamptz,
  status text NOT NULL DEFAULT 'reserved',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS intake_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  trigger_kind text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  status text NOT NULL,
  imported_count integer NOT NULL DEFAULT 0,
  skipped_duplicate_count integer NOT NULL DEFAULT 0,
  skipped_non_candidate_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  failure_summary text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
