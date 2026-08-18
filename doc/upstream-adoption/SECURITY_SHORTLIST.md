# Security and correctness shortlist

The clean branch already contains the current upstream fixes listed below. No separate cherry-pick is required where the fix is already in the full upstream synchronization. The only bounded backport made in this phase is TF's active-wakeup idempotency guard (`9001`).

| Shortlist item | Upstream evidence | Disposition |
| --- | --- | --- |
| Invalid agent credentials must not downgrade to local user | `1c366a905` | Included through full synchronization; verify with auth tests |
| Interaction resolver authorization consistency | `10d055518` | Included through full synchronization; verify with interaction tests |
| Review policy/verdict authorization and serialization | `37fde84ab`, `373b675f9`, `991f40bb2`, `edb808353`, `277c13529` | Included through full synchronization; no separate backport |
| Cross-tenant existence oracle | `7f2ed0ad9` | Included through full synchronization; verify tenant-isolation tests |
| Cloud-proxied live-events WebSocket authentication | `2c53437fc` | Included through full synchronization; verify proxy/auth tests |
| Unsafe npx command guidance / CWE-78 | `fdb9a4880` | Included through full synchronization; verify CLI tests |
| Plugin worker company scoping | `a7186dce4`, `3093c5e69`, `f2f168f6a` | Included through full synchronization; verify plugin-host tests |
| One active wake per company/agent/idempotency key | TF `9001_agent_wakeup_active_idempotency_uq.sql` | Bounded backport retained in core; schema and migration added in this branch |
| Review-path wakeup idempotency | upstream `0206_review_path_recovery_idempotency_index.sql` | Preserve upstream implementation alongside TF active-wakeup guard |
| Evidence provenance registry | TF `9002_evidence_provenance_registry.sql` | Not an immediate core backport; plugin/defer pending an owner-approved consumer |
| Company-scoped environments | TF `9003_restore_company_scoped_environments.sql` | Owner decision required; no automatic reversal |

Immediate bounded backports are limited to controls that are independently safe, have a concrete live correctness benefit, and do not conflict with newer upstream semantics. All other listed fixes arrive through the upstream baseline and are validated as one synchronization set.
