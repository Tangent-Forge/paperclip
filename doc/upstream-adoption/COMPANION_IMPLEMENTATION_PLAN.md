# Companion implementation plan against synchronized upstream

Status: planning only. No Companion UI, plugin, worker, route, migration, or
live installation is implemented by this document.

Source baseline: ancestry bridge
`76e37dfd0ee9f729d00e2175d35c30d2f3c75a4f`, preserving candidate tree
`1fd6399a65bfc83f87e3e469605ca7ec6a04c5a2`, on upstream
`d1cd9c37f49e21e0f248918bce24cff137e3802d`. The bridge also makes old TF
master an ancestor without importing its obsolete tree.

## Identity and terminology

- The system-level assistant is **Paperclip Companion**.
- Its first-class surfaces may be named **Board Console** or **Company
  Console**.
- Companion is not an organizational CEO and must not impersonate or create an
  organizational agent.
- **Talk to CEO**, **Talk to CoS**, and equivalent actions are direct
  conversations with the selected organizational agent, not names for the
  Companion system thread.

## Upstream capabilities to reuse

The synchronized baseline supplies task chat, Decisions/propose and interaction
responses, persistent task/plugin agent sessions, human attribution, scoped
plugin host services, search/navigation, authz, budgets/costs, live event
streams, and direct agent-session interaction. Companion must compose these
contracts rather than fork them.

## Proposed implementation sequence

### 1. Contract and authorization boundary

Define a Companion capability contract in the plugin SDK/host:

- company-scoped read context for issues, decisions, agents, runs, budgets,
  costs, sessions, and live events;
- explicit board-operator capabilities for context assembly, proposal, and
  direct agent invocation;
- human actor attribution and audit records on every Companion action;
- fail-closed company and instance scope checks;
- no secret values in context assembly or UI payloads.

Deliverable: reviewed SDK types, capability manifest, authorization matrix,
and negative cross-company tests.

### 2. First-class unified surface

Add a Companion plugin UI route/slot that provides a unified Paperclip
Companion / Board Console / Company Console entry point. It should link into,
not replace, upstream task chat, Decisions, inbox, agent sessions, costs, and
live runs.

Deliverable: UI information architecture, loading/error/empty states, and
accessibility tests. No duplicate task-chat data model.

### 3. Governed cross-task context

Build a bounded context assembler that retrieves current company-scoped
issues, blockers, decisions, approvals, agent/session state, budget/cost
signals, and recent live events. Every item carries source IDs, timestamps,
company scope, and freshness/provenance markers.

Deliverable: context schema, size/recency limits, redaction rules, and fixture
tests for missing/stale/conflicting evidence.

### 4. Companion and organizational-agent session lifecycle

Companion system threads are plugin-owned, company-scoped records. They carry
the authenticated human principal, message actor type, source/provenance IDs,
context-snapshot references, timestamps, and audit correlation without
creating an `agents` row.

Use upstream `agents.sessions` only for direct organizational-agent
communication and delegation. Its create/list protocol requires an `agentId`,
`agent_task_sessions.agent_id` is non-null, and the host wakes that named
agent. A **Talk to CEO/CoS** thread therefore maps to the selected real agent
and is labeled as that agent's conversation.

Deliverable: separate Companion-thread and direct-agent-session contracts plus
tests for create, resume, send, stream, close, interruption, attribution, and
authorization changes.

### 5. Decision orchestration

Map authenticated human intent to upstream proposal, interaction, approval,
task, or agent-session actions. Require explicit confirmation for mutations
and preserve upstream resolver/addressee/continuation semantics.

Companion may surface an approval or interaction and submit an authenticated
human response, but it may not approve as the plugin, Companion, `system`, or
an organizational agent. Use the existing authenticated board UI/API route,
which derives the actor from the request session, for initial approval
submission. Do not add a user-session-bound host contract unless this route is
proven insufficient and a separate design is approved.

Deliverable: decision routing table, confirmation UX, idempotency contract,
and audit/readback tests.

### 6. Live timeline and cost context

Compose upstream SSE/live-event and cost/budget streams into a read-only
Companion timeline. Do not create a second event or accounting authority.

Deliverable: event correlation model, reconnect/backfill behavior, budget
threshold display rules, and tests for out-of-order/duplicate events.

### 7. Packaging and operations

Package the Companion surface/worker as an installable plugin with explicit
configuration, migration namespace if needed, deployment owner, rollback
procedure, and acceptance fixtures. Installation and enablement require a
separate approval.

## Explicit non-goals

- no generic Paperclip task-chat replacement;
- no replacement auth/session/interaction protocol;
- no organizational-agent identity for the Companion system thread;
- no plugin/system-identity approval decisions;
- no new core accounting or live-event system;
- no automatic resolution of 9003 beyond the approved retirement design;
- no implementation in the current synchronization PR unless separately
  authorized.

## Acceptance gates before Companion implementation

- synchronized baseline PR reviewed and merged through normal governance;
- 9003 production retirement separately designed, dry-run, approved, and
  executed under its own gate;
- plugin host/SDK contract and authz matrix accepted;
- Companion scope, owner, and deployment/cutover plan approved;
- qualified-suite exceptions either resolved or explicitly accepted for the
  Companion workstream.
