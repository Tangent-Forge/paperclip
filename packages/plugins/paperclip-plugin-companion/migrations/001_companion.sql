-- Paperclip Companion plugin-owned schema.
-- Companion is a system-level assistant, not an organizational agent: no row
-- here or anywhere else in this plugin's storage carries an agent_id.

CREATE TABLE companion_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  title text NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX companion_threads_company_updated_idx
  ON companion_threads (company_id, updated_at DESC);

CREATE TABLE companion_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES companion_threads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('human', 'companion')),
  -- Set only for role = 'human'. A 'companion' row must never carry an
  -- actor_user_id — Companion is not a human and does not act as one.
  actor_user_id text,
  body text NOT NULL,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_messages_actor_role_chk CHECK (
    (role = 'human' AND actor_user_id IS NOT NULL) OR
    (role = 'companion' AND actor_user_id IS NULL)
  )
);

CREATE INDEX companion_messages_thread_created_idx
  ON companion_messages (thread_id, created_at);
CREATE INDEX companion_messages_company_created_idx
  ON companion_messages (company_id, created_at DESC);

CREATE TABLE companion_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES companion_threads(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES companion_messages(id) ON DELETE CASCADE,
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
  ON companion_action_proposals (company_id, interaction_id);
CREATE INDEX companion_action_proposals_thread_idx
  ON companion_action_proposals (company_id, thread_id, created_at DESC);
