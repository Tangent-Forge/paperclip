# Upstream-adoption reconciliation ledger

This ledger is the control record for the preparation branch. Every meaningful TF customization must end with exactly one disposition from the approved set. A row marked `owner decision required`, `semantic merge required`, or `defer` blocks any merge to TF master.

Approved dispositions:

- upstream replaces TF implementation
- retain TF core patch
- move TF behavior to plugin
- move TF behavior to configuration/operations
- semantic merge required
- defer
- owner decision required

## Current phase ledger

| Area | Disposition | Evidence / decision condition |
| --- | --- | --- |
| Migration history and hash identity | semantic merge required | Live ledger has 186 rows, three TF hashes, and a duplicate upstream hash; preserve by hash and never renumber |
| Active wakeup idempotency | retain TF core patch | Safe independent index; integrated as migration 9001 after upstream baseline |
| Evidence registry | move TF behavior to plugin | No core consumers; require plugin-owned migration/schema contract before migration |
| Environment tenancy | owner decision required | Live company-scoped shape conflicts with upstream instance-scoped model |
| Shared sidebar badge | upstream replaces TF implementation | Upstream exposes equivalent capability; verify `agentOperations` semantics |
| Canary execution constraints | retain TF core patch | Upstream sandbox contract does not enforce TF's exact env/path/network/task restrictions |
| Work contract/admission | move TF behavior to plugin | Linear Sync is the current consumer; remove core export only after plugin contract tests |
| Plugin host/session APIs | upstream replaces TF implementation | Upstream now provides agent sessions, streaming, orchestration, SDK clients, and UI slots; verify TF plugins against it |
| TF Brain, Linear Sync, Council intake | move TF behavior to plugin | Existing plugin boundaries are the intended ownership model |
| Additional adapters | move TF behavior to plugin | Prefer upstream adapter/plugin contracts; retain only demonstrated provider requirements |
| Gemini/local adapter | semantic merge required | Dirty adapter worktree preserved; compare against current upstream adapter/session contract |
| UI Decisions/task chat | upstream replaces TF implementation / defer | Upstream has current task chat, Decisions, search, drafts, and artifact patterns; no TF first-class Companion core should be retained without a gap |
| Runtime/observability | move TF behavior to configuration/operations | Operational controls should not become product core without deployment ownership |
| Guardian/cutover controls | move TF behavior to configuration/operations | Delivery governance remains outside Paperclip product synchronization |

## Hard stops

- No live restart, deployment, cutover, migration, or process-unit change is authorized by this ledger.
- No blanket `ours`/`theirs` conflict resolution is permitted.
- No TF implementation is retained solely because it exists; retention requires a demonstrated upstream gap.
- Before merge, attach the exact resulting baseline SHA, retained core-delta manifest, replaced/removed patches, plugin/config migrations, unresolved semantic conflicts, security fixes, database reconciliation, complete tests, Companion delta, and cutover plan.
