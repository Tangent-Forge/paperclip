CREATE TABLE plugin_linear_sync_861efcc900.linear_issue_links (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  linear_issue_id text NOT NULL,
  linear_identifier text,
  paperclip_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  last_linear_updated_at timestamptz,
  last_imported_at timestamptz NOT NULL DEFAULT now(),
  last_synced_to_linear_at timestamptz,
  status text NOT NULL DEFAULT 'reserved',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, linear_issue_id),
  UNIQUE (company_id, paperclip_issue_id)
);

CREATE TABLE plugin_linear_sync_861efcc900.sync_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  trigger_kind text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  imported_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_duplicate_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  failure_summary text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX linear_issue_links_company_updated_idx
  ON plugin_linear_sync_861efcc900.linear_issue_links (company_id, last_linear_updated_at DESC);

CREATE INDEX sync_runs_company_started_idx
  ON plugin_linear_sync_861efcc900.sync_runs (company_id, started_at DESC);
