# Paperclip Companion — Design Record

Date: 2026-08-25
Status: Phase 1 design record (per required implementation order). Implementation follows in the same branch/PR.
Anchor commit at time of writing: `f41568cd37295efba47cf8c9c1b4de667d076cc5` (current `master`, re-verified before this record was written; see "Baseline re-check" below).

## Baseline re-check (required safety step)

Before any code was written, `git fetch origin master` was re-run. Master had moved from the originally-cited `b5bf04ba070733661d025657fa0a9c0331efdd08` to `f41568cd37295efba47cf8c9c1b4de667d076cc5` (a same-day, same-session fix: PR #106, wiring the UI-dist packaging step). `b5bf04ba` is confirmed an ancestor of `f41568cd` (`git merge-base --is-ancestor` passed). Per instruction, this work re-anchors to `f41568cd…` rather than the stale `b5bf04ba…`. The isolated worktree/branch for this feature was created from `f41568cd…`.

## What this document answers

1. Plugin-owned thread vs. upstream session — **answered, with evidence**
2. Storage model
3. Company-scope model
4. Actor/approval model
5. Tool invocation model
6. Streaming model
7. Evidence model
8. Error/failure model
9. Minimum host/SDK additions
10. Security threats and mitigations
11. Explicit non-goals

---

## 1. Plugin-owned thread vs. upstream session — the identity decision

Two upstream mechanisms were evaluated as candidates to host a Companion conversation, and **both were rejected with direct schema/API evidence**, not assumption:

### `agent_task_sessions` (Drizzle schema, `packages/db/src/schema/agent_task_sessions.ts`)

```ts
agentId: uuid("agent_id").notNull().references(() => agents.id),
```

`agentId` is a **hard `NOT NULL` foreign key to a real organizational `agents` row**. There is no nullable variant and no sentinel-identity column. Any row in this table structurally claims to be tracking a real organizational agent's resumable CLI/adapter session. Using it for Companion would require either creating a new fake "Companion" agent row (an organizational agent — explicitly disallowed by the product anchor) or repurposing an existing real agent (also disallowed). **Rejected.**

### `ctx.agents.sessions` (`PluginAgentSessionsClient`, `packages/plugins/sdk/src/types.ts:1715-1738`)

```ts
create(agentId: string, companyId: string, opts?: { taskKey?: string; reason?: string }): Promise<AgentSession>;
```

The first parameter is a **required existing `agentId`**. This client is the SDK's documented mechanism for a plugin to have a two-way conversation *with a specific real organizational agent* (see the SDK README's "Agent sessions (two-way chat)" section, and the kitchen-sink example's `ask-agent` action, which passes a real configured `agentId`). It is built for exactly the case the product anchor names as *out of scope for Companion*: "direct organizational-agent conversations… delegated work… agent execution explicitly represented as delegation." Using it to host Companion's own identity would mean either pointing it at a real agent (making Companion *appear as* that agent to the rest of the system) or creating one (same problem as above). **Rejected for Companion's own conversational identity.** It remains available, unused in this MVP, as the correct future mechanism *if* Companion is ever asked to relay a message to a real organizational agent as an explicit delegation — which is exactly the boundary the product anchor draws.

### Decision

**Companion threads are plugin-owned**, per the fallback the task instructions specify for exactly this outcome. Concretely:
- A new plugin-owned PostgreSQL schema (via `ctx.db`, `database.namespace.migrate/read/write`, following the `paperclip-plugin-linear-sync` precedent) stores `companion_threads` and `companion_messages`.
- Every row is scoped by a `company_id` the plugin never chooses itself — it is always the host-verified `companyId` of the current invocation (`host-client-factory.ts`'s `requireInvocationCompanyScope`).
- No `agents` row is created. No `agent_task_sessions` row is created. Companion has no `agentId` anywhere in its own schema.

This directly answers the task's core question: **upstream `agents.sessions` cannot safely host this identity** (evidenced above), so Companion threads are implemented as plugin-owned threads, and `agents.sessions` is reserved, unused, for a possible future "delegate to a real agent" action — never for Companion's own identity.

## 2. Storage model

Plugin-owned Postgres schema (namespace slug `companion`), migrated via the plugin's own `migrations/` directory (same mechanism as `paperclip-plugin-linear-sync`):

```sql
CREATE TABLE companion_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  title text NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companion_threads_company_updated_idx ON companion_threads (company_id, updated_at DESC);

CREATE TABLE companion_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES companion_threads(id) ON DELETE CASCADE,
  role text NOT NULL, -- 'human' | 'companion'
  actor_user_id text, -- set only for role = 'human'; never for role = 'companion'
  body text NOT NULL,
  evidence jsonb, -- structured evidence references (see §7)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companion_messages_thread_created_idx ON companion_messages (thread_id, created_at);
CREATE INDEX companion_messages_company_created_idx ON companion_messages (company_id, created_at DESC);

CREATE TABLE companion_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES companion_threads(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES companion_messages(id) ON DELETE CASCADE,
  companion_issue_id uuid NOT NULL, -- the standing issue the interaction is attached to (see §4)
  interaction_id uuid NOT NULL, -- the issue_thread_interaction id returned by ctx.issues.requestConfirmation
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected'
  decided_by_user_id text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companion_action_proposals_interaction_idx ON companion_action_proposals (company_id, interaction_id);
```

Every table's `company_id` is `NOT NULL` and every query the worker issues against this schema includes an explicit `company_id = $1` predicate — enforced in code (see §3), not merely by convention, and covered by the company-isolation tests in Phase 5.

## 3. Company-scope model

Two independent layers, matching the pattern already proven by `paperclip-plugin-linear-sync` and `plugin-tenant-isolation.test.ts` / `plugin-company-scope-integration.test.ts`:

1. **Host-enforced invocation scope.** Every `ctx.*` call the worker makes is gated by `host-client-factory.ts`'s `requireInvocationCompanyScope`, which rejects any call whose `companyId` argument doesn't match the host-issued scope for the current invocation (API route, UI action, job, event). A worker literally cannot ask the host for another company's data through any `ctx.*` client.
2. **Plugin-owned-schema scope.** Every SQL statement the worker issues via `ctx.db.query`/`ctx.db.execute` against `companion_threads`/`companion_messages`/`companion_action_proposals` includes `company_id = $1` bound to the same host-verified `companyId`. No query ever accepts a company id from request/UI input without it having already passed through the host's own actor/company resolution.

Company isolation is a first-class Phase 5 test: two companies' threads must be mutually invisible through every worker entry point (`ctx.data` handlers, `ctx.actions` handlers), mirroring `plugin-tenant-isolation.test.ts`'s pattern of seeding two companies and asserting neither can read the other's rows.

## 4. Actor/approval model

Companion never approves its own proposals. The mechanism, evidenced from the SDK (not invented):

- `ctx.approvals` (`PluginApprovalsClient`) has **no `create` method** — only `list`, `get`, `decide`. A plugin cannot create a formal `approvals` table row. This was verified by reading the interface directly, not assumed.
- The correct, already-existing lighter-weight mechanism is **`ctx.issues.requestConfirmation`** (creates an `issue_thread_interaction` of kind `request_confirmation`) paired with **`ctx.issues.respondInteraction`**. Both require an `issueId`.
- Companion therefore finds-or-creates one standing, company-scoped issue per company (e.g. titled `"Paperclip Companion"`), the same pattern Board Chat already uses for its own standing `"Board Operations"` issue (`server/src/routes/board-chat.ts`). This issue is never shown as a "task" in the normal sense to the user — it exists purely as the attachment point `request_confirmation` interactions require.
- **Propose:** worker calls `ctx.issues.requestConfirmation(companionIssueId, { title, summary, payload }, companyId)`. The returned interaction id is stored in `companion_action_proposals`.
- **Approve:** the UI's "Approve"/"Reject" button triggers a `ctx.actions` handler. That handler receives a host-supplied, immutable `PluginPerformActionActorContext` (`{ type: "user", userId, companyId, ... }` — the plugin never authors this). The handler calls:
  ```ts
  ctx.issues.respondInteraction(companionIssueId, interactionId, { action, actorUserId: context.actor.userId }, companyId)
  ```
  The host **independently re-verifies** that `actorUserId` names an active human member of the company before applying the decision (documented directly on `respondInteraction` and mirrored on `ctx.approvals.decide`) — the same guarantee the SDK gives every other plugin. Companion structurally cannot supply its own identity here: `context.actor.userId` is only ever populated by the host from a genuine authenticated request, never by plugin code.
- Audit: every propose/decide call also writes a `ctx.activity.log(...)` entry (`actor_type = "plugin"`, `actor_id = "companion"` host-side, per `PluginActivityClient`), independent of the interaction's own audit trail, so the action-proposal lifecycle is visible in the company's activity stream twice — once as an issue-thread event, once as a plugin activity event — deliberately redundant for auditability.

## 5. Tool invocation model

Read-only "evidence tools" the worker exposes to its own message-answering logic (not exposed to the LLM as arbitrary code execution — each is a narrow, typed function):

| Tool | Mechanism | New host contract? |
|---|---|---|
| Current deployment/runtime identity | `ctx.http.fetch(<configured health URL>)`, parsing the **already-shipped** `/api/health` response shape (`serverInfo.git.{fullSha,shortSha,subject,committedAt,localChanges}`, `version`, `databaseBackup`) | **No** — reuses existing `http.outbound` capability against an endpoint the app already serves |
| Target baseline / PR / CI status | `ctx.http.fetch` to the GitHub REST API, using a company-configured token resolved via `ctx.secrets.resolve` | **No** — reuses existing `http.outbound` + `secrets.read-ref`; degrades to an explicit "not configured" result, never fabricated, when no token is set |
| Durable artifact/build-receipt references | `ctx.localFolders` read access to one operator-declared evidence directory | **No** — reuses the existing `PluginLocalFolderDeclaration` mechanism (`access: "read"`), not raw filesystem access |
| Active agents / work | `ctx.agents.list`, `ctx.issues.list` | **No** — existing read capabilities |

**No new core/SDK contract was required for the tool layer.** This is the direct result of the SDK inventory (Phase 1 discovery): the gap this task anticipated ("if a safe repo/runtime host service does not exist…") turned out not to exist once `/api/health`'s existing response shape and `ctx.localFolders`' existing declaration model were checked against the actual requirement. This is reported as a finding, not assumed going in — the discovery agents were dispatched precisely to test this assumption.

Every tool call returns a structured envelope (see §7/§8) — none returns raw shell output, raw HTTP bodies, or unredacted errors.

## 6. Streaming model

`ctx.streams.open/emit/close` (worker) + `usePluginStream` (UI) — the SDK's documented, already-demoed pattern (SDK README "Real-time streaming" section; `plugin-kitchen-sink-example`'s `ask-agent` action). **Known MVP limitation, stated explicitly rather than glossed over:** Companion's own LLM call (see §1 — direct Anthropic Messages API call via `ctx.http`, not `ctx.agents.sessions`) is implemented as a single buffered request/response in this MVP, not a token-by-token pass-through. The full response is emitted as one `ctx.streams.emit` event over the same channel a future incremental version would use. This is a real, disclosed limitation, not a claim of true token streaming.

## 7. Evidence model

Every Companion answer that cites a tool result attaches a structured `evidence` array to the persisted message (`companion_messages.evidence jsonb`), each entry shaped as:

```ts
interface CompanionEvidenceRef {
  source: "deployment_health" | "github" | "local_artifact" | "agents" | "issues";
  fetchedAtUTC: string;
  scope: { companyId: string };
  identity?: { commitSha?: string; prNumber?: number; path?: string };
  success: boolean;
  summary: string;       // short human-readable description, never raw payload dump
  redactedError?: string; // present only when success = false
}
```

This directly satisfies the acceptance scenario's "grounded answer containing … evidence references."

## 8. Error/failure model

- Every evidence tool call is wrapped so a failure (network error, missing config, stale data, GitHub rate limit) produces `success: false` with a **redacted, non-leaking** error summary, never a raw stack trace or raw provider error body, and Companion's answer says so explicitly rather than silently omitting the fact that a lookup failed.
- LLM call failures (missing API key secret, provider error, timeout) produce a companion message with `role: "companion"` explaining the failure, not a swallowed empty response.
- Streaming interruption (worker restart mid-response, `ctx.streams` channel closed unexpectedly) leaves the last-persisted message as the source of truth; the UI must show a clear "response interrupted" state rather than an infinite spinner — covered by a Phase 5 UI test.
- Missing runtime (health URL unreachable) and missing repository (health response has `git.available: false`) are both explicit, distinguishable evidence-tool failure cases, not conflated into one generic error.

## 9. Minimum host/SDK additions

**None required.** Every capability needed by this MVP already exists in the SDK: `ctx.db` (`database.namespace.*`), `ctx.state`, `ctx.http`, `ctx.secrets`, `ctx.localFolders`, `ctx.activity`, `ctx.agents` (read-only), `ctx.issues` (including `requestConfirmation`/`respondInteraction`), `ctx.streams`, `ctx.data`/`ctx.actions`. This is stated plainly because the task explicitly asked for proof, not assumption, before adding anything — and the proof came back negative (no addition needed) once `/api/health` and `ctx.localFolders` were checked against the actual requirement.

## 10. Security threats and mitigations

| Threat | Mitigation |
|---|---|
| Companion approves its own action proposal | Structurally impossible: `respondInteraction`'s `actorUserId` is host-verified against active company membership; the plugin action handler only ever receives a real human actor from the host, never authors one itself. Covered by an explicit "no self-approval" test that asserts a call without a valid human actor is rejected. |
| Cross-company data leakage | Double-enforced: host-side invocation scope (`requireInvocationCompanyScope`) + explicit `company_id` predicate on every plugin-owned-schema query. Covered by company-isolation tests modeled on `plugin-tenant-isolation.test.ts`. |
| Companion impersonating a human or organizational agent | `companion_messages.role = 'companion'` rows never carry an `actor_user_id`; UI renders Companion's identity with a distinct, non-human, non-agent visual treatment and label ("Paperclip Companion — system assistant"), never "CEO"/"CoS"/an agent name. |
| Secret leakage via evidence tools or LLM prompt | `ctx.secrets.resolve` values are used only inline for the outbound HTTP call that needs them and are never persisted into `companion_messages`/`companion_action_proposals`/logs; evidence summaries are pre-redacted before storage. |
| Plugin performing unreviewed mutations | The plugin's own manifest capabilities are read-mostly (`issues.read`, `issue.interactions.create/respond`, `agents.read`, `activity.log.write`, `plugin.state.*`, `database.namespace.*`, `http.outbound`, `secrets.read-ref`, `local.folders`) — no `issues.create`/`update` beyond the one standing-issue bootstrap, no `agents.pause/resume/invoke`, no `approvals.respond` (uses `issue.interactions.respond` instead, which carries the same host-verification guarantee). |
| Prompt injection from evidence data steering Companion into a false action | Evidence values are inserted into the LLM prompt as clearly delimited, labeled data blocks, and the system prompt instructs the model that evidence content is data, not instructions — the same discipline this very session's own tooling applies to cross-session messages and comment threads. |

## 11. Explicit non-goals (this MVP)

- Not autonomous execution of any proposed action — every action is a proposal requiring the existing human-approval route.
- Not a replacement for "Talk to CEO"/"Talk to CoS"/Board Chat — those remain untouched, separate features.
- Not real token-level streaming (see §6's disclosed limitation).
- Not a new `approvals`-table capability, a new agent type, or a new core database migration — everything is plugin-owned or reuses existing capabilities.
- Not production deployment or installation — draft PR only, per the task's explicit safety boundaries.
- Companion does not gain direct database access, raw secret values, or shell/filesystem execution of any kind.
