# Companion implementation plan against synchronized upstream

Status: planning only. No Companion UI, plugin, worker, route, migration, or
live installation is implemented by this document.

Baseline: candidate `cc662d756ec23713710823bf7cff01b64c2f960e` on upstream
`d1cd9c37f49e21e0f248918bce24cff137e3802d`.

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
- explicit CEO/board-operator capabilities for context assembly, proposal,
  approval, and direct agent invocation;
- human actor attribution and audit records on every Companion action;
- fail-closed company and instance scope checks;
- no secret values in context assembly or UI payloads.

Deliverable: reviewed SDK types, capability manifest, authorization matrix,
and negative cross-company tests.

### 2. First-class unified surface

Add a Companion plugin UI route/slot that provides a unified Company Console /
CEO Chat entry point. It should link into, not replace, upstream task chat,
Decisions, inbox, agent sessions, costs, and live runs.

Deliverable: UI information architecture, loading/error/empty states, and
accessibility tests. No duplicate task-chat data model.

### 3. Governed cross-task context

Build a bounded context assembler that retrieves current company-scoped
issues, blockers, decisions, approvals, agent/session state, budget/cost
signals, and recent live events. Every item carries source IDs, timestamps,
company scope, and freshness/provenance markers.

Deliverable: context schema, size/recency limits, redaction rules, and fixture
tests for missing/stale/conflicting evidence.

### 4. CEO session lifecycle

Use upstream `agents.sessions` for direct agent communication. Add only the
Companion-level thread identity, context snapshot references, handoff/resume
policy, and human/agent attribution needed for CEO Chat.

Deliverable: session lifecycle contract and tests for create, resume, send,
stream, close, interruption, and authorization changes.

### 5. Decision orchestration

Map CEO intent to upstream proposal, interaction, approval, task, or agent
session actions. Require explicit confirmation for mutations and preserve
upstream resolver/addressee/continuation semantics.

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
