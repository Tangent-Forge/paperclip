# Layer reconciliation report

This report records the ordered review after database/shared-contract work. It is an integration assessment, not a deployment approval.

The 9003 owner decision is resolved for the synchronized baseline: adopt
upstream instance-scoped environment identity/defaults while preserving
company-scoped secret/provider bindings, leases, accounting, activity, and
audit attribution. Production row retirement remains separately gated by
`ENVIRONMENT_9003_RETIREMENT_PLAN.md`.

## Authorization, interactions, and sessions

The upstream baseline now provides the relevant authorization and interaction primitives:

- invalid agent credentials fail instead of downgrading to the local user (`1c366a905`);
- interaction resolvers use consistent authorization (`10d055518`);
- review policy/verdict authorization and serialization fixes are present (`37fde84ab`, `373b675f9`, `991f40bb2`, `edb808353`, `277c13529`);
- cross-tenant existence behavior is fail-closed (`7f2ed0ad9`);
- plugin workers resolve and enforce company scope (`a7186dce4`, `3093c5e69`, `f2f168f6a`);
- the SDK exposes interaction create/read/respond capability boundaries, including attachment reads and human-attributed comments.

Disposition: upstream replaces duplicated TF route/service implementations where behavior is equivalent. The large TF changes in `server/src/routes/agents.ts`, `server/src/routes/issues.ts`, `server/src/services/agents.ts`, and `server/src/services/issues.ts` require endpoint-by-endpoint semantic tests; the diff size is not evidence that either side is correct.

Upstream also has persistent task sessions across issue comments and execution handoffs (`b90da4d11`, `877490936`) and plugin agent-session turn/reply delivery (`caae2778f`). The TF-specific session behavior should be compared against those host-owned lifecycles before any retention.

## Plugin SDK and host services

The upstream host/SDK now has first-class surfaces for:

- company-scoped plugin state, events, secrets, activity, projects/workspaces, issues/comments/documents, approvals, agents, access, authorization, and streams;
- issue interactions with capability-specific create/read/respond permissions;
- agent sessions with create/list/send/close operations and streamed `chunk/status/done/error` events;
- server-side `agentSessions` host services that verify company scope, agent membership, and plugin availability;
- UI slots, plugin routes, and SSE-backed plugin streams.

This covers the correct ownership for TF Brain, Linear Sync, Council intake, and future Companion UI/worker behavior. TF core additions that only make those plugins easier should move to plugin SDK/host contracts, not remain in Paperclip core.

## UI, Decisions, and task chat

Current upstream includes task-chat components and behavior for drafts, ordered blockers, artifacts/documents, live runs, interaction cards, and message streaming. It also includes search filters/sorting/command-palette work and Decisions/attention-queue surfaces (`606aa4f26`, `36ec79c19`, `30c49c832`, `9c1f8e788`).

Disposition: upstream replaces TF duplicate inbox/task-chat/decision implementations where the data contract matches. TF-only presentation or workflow requirements must be expressed as plugin UI slots and routes when they are Companion-specific.

Capability delta after synchronization: upstream supplies a strong task/issue conversation and Decisions foundation, but it does not yet provide a first-class CEO Chat / Company Console / unified Companion surface. The open roadmap/issues remain a product gap, not a reason to preserve a TF fork of upstream task chat.

## Adapters, runtime, and configuration

Upstream now owns the current execution/runtime contract for ACP lifecycle settlement, coordinator-owned resource ledgers, persistent sandbox sessions, streamed provider output, Tailscale HTTPS/lease recovery, workspace sync-back, and bounded callback polling (`e52b8a343`, `b446ff59b`, `cfed36ea6`, `4e76227f1`, `4c349fe6b`, `f4802b1bb`).

Disposition:

- adapter behavior that is a provider implementation belongs behind the upstream adapter/plugin contract;
- TF provider additions require a demonstrated provider requirement and should be packaged as plugins/adapters;
- TF execution constraints remain a core security candidate because they restrict environment inheritance, secret bindings, network, paths, git mutation, and task/agent creation more narrowly than upstream's general sandbox capability contract;
- operational runtime exposure, observability, health, Guardian, and cutover controls should move to configuration/operations rather than Paperclip product core.

The dirty Gemini adapter worktree remains preserved separately and is not used as an implicit source for this branch.
