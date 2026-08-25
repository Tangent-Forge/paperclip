-- Paperclip Companion plugin-owned schema.
-- Companion is a system-level assistant, not an organizational agent: no row
-- here or anywhere else in this plugin's storage carries an agent_id.
--
-- Every object below is qualified with plugin_companion_46345b9b3b — the
-- host-derived namespace for this plugin (see
-- server/src/services/plugin-database.ts's derivePluginDatabaseNamespace()):
-- sha256("paperclipai.companion").slice(0,10) = "46345b9b3b", combined with
-- this plugin's manifest.database.namespaceSlug = "companion". The host's
-- migration validator rejects any unqualified object reference outright, so
-- this coupling is required, not stylistic — mirrors
-- paperclip-plugin-linear-sync's own migration file. If PLUGIN_ID
-- (src/constants.ts) or the manifest's `database.namespaceSlug`
-- (src/manifest.ts) ever changes, this derived namespace changes too, and
-- every reference below must be updated to match.

CREATE TABLE plugin_companion_46345b9b3b.companion_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  title text NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX companion_threads_company_updated_idx
  ON plugin_companion_46345b9b3b.companion_threads (company_id, updated_at DESC);

CREATE TABLE plugin_companion_46345b9b3b.companion_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES plugin_companion_46345b9b3b.companion_threads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('human', 'companion')),
  -- Set only for role = 'human'. A 'companion' row must never carry an
  -- actor_user_id — Companion is not a human and does not act as one.
  actor_user_id text,
  body text NOT NULL,
  evidence jsonb,
  -- Client-supplied dedup key for one logical send-message request (shared by
  -- the human row and the companion reply row it produced). NULL for any row
  -- created without an idempotency key (e.g. legacy callers). Scoped by role
  -- so the human row and its companion reply — which intentionally share the
  -- same client_request_id — don't collide with each other.
  client_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_messages_actor_role_chk CHECK (
    (role = 'human' AND actor_user_id IS NOT NULL) OR
    (role = 'companion' AND actor_user_id IS NULL)
  )
);

CREATE INDEX companion_messages_thread_created_idx
  ON plugin_companion_46345b9b3b.companion_messages (thread_id, created_at);
CREATE INDEX companion_messages_company_created_idx
  ON plugin_companion_46345b9b3b.companion_messages (company_id, created_at DESC);
-- Idempotency: a retried sendMessage call with the same client_request_id
-- must not create a second human row or a second companion row.
CREATE UNIQUE INDEX companion_messages_dedup_idx
  ON plugin_companion_46345b9b3b.companion_messages (thread_id, role, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE plugin_companion_46345b9b3b.companion_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES plugin_companion_46345b9b3b.companion_threads(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES plugin_companion_46345b9b3b.companion_messages(id) ON DELETE CASCADE,
  companion_issue_id uuid NOT NULL,
  interaction_id uuid NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_by_user_id text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_action_proposals_decision_chk CHECK (
    (status = 'pending' AND decided_by_user_id IS NULL AND decided_at IS NULL) OR
    (status IN ('accepted', 'rejected') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX companion_action_proposals_interaction_idx
  ON plugin_companion_46345b9b3b.companion_action_proposals (company_id, interaction_id);
CREATE INDEX companion_action_proposals_thread_idx
  ON plugin_companion_46345b9b3b.companion_action_proposals (company_id, thread_id, created_at DESC);
-- Idempotency: the UI only ever offers one "propose next action" button per
-- message (see src/ui/index.tsx), so a message must resolve to at most one
-- proposal. This is also the mechanism that makes a double-click / duplicate
-- submit safe: the loser of the race gets the winner's row back instead of
-- creating a second proposal (and a second standing-issue interaction).
CREATE UNIQUE INDEX companion_action_proposals_message_idx
  ON plugin_companion_46345b9b3b.companion_action_proposals (company_id, message_id);

-- Fast lookup/cache for the standing "Paperclip Companion (system)" issue.
-- Actual create concurrency is guarded by the core issue service's durable
-- idempotency key; this primary key makes the plugin-local association unique
-- as an independent backstop. See findOrCreateCompanionIssue().
CREATE TABLE plugin_companion_46345b9b3b.companion_company_state (
  company_id uuid PRIMARY KEY,
  companion_issue_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
