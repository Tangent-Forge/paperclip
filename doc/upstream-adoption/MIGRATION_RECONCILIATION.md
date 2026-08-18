# Database and shared-contract reconciliation

Status: phase 1 complete for history mapping; environment and evidence semantics remain unresolved by design.

## Live migration ledger

Read-only inspection of `tf-postgres` found `186` rows in `drizzle.__drizzle_migrations`.

- `183` hashes map exactly to migration SQL present in current upstream.
- Three rows are TF-only hashes:
  - live ledger id `105`, created_at `1781490100002`: `9001_agent_wakeup_active_idempotency_uq.sql`
  - live ledger id `152`, created_at `1785391098075`: `9002_evidence_provenance_registry.sql`
  - live ledger id `186`, created_at `1785391098109`: `9003_restore_company_scoped_environments.sql`
- The ledger also contains a duplicate `0102_managed_sandbox_dedup_index.sql` hash at ids `103` and `104`. This is historical evidence, not permission to delete or renumber a row.
- The live applied sequence includes upstream migrations through `0183_connection_user_authorization_state`; TF's deployed tree later removed the corresponding `0151`-`0183` files even though their hashes remain applied. The clean upstream branch restores those files.

## Reconciliation rules

1. Never rewrite or renumber an applied migration row.
2. Keep migration identity by content hash; a migration absent from the new source tree is not silently treated as unapplied.
3. Do not run a migration against live during this project.
4. Do not recreate a TF migration in a new file with changed SQL under the old identity.
5. New-database ordering may append an independent retained TF migration after the upstream baseline, while live history remains recognized by its original hash.

## Phase 1 result

`9001` is retained as a bounded core correctness/security patch. The integration branch includes the exact SQL and appends its journal entry at `idx=224`, retaining the original `when=1781490100001`; the upstream review-path idempotency index and payload index remain in the schema and the active wakeup index is added alongside them. This is a semantic merge, not an ours/theirs replacement.

`9002` creates 13 evidence-registry tables and is exported only from the TF schema index; no application consumer was found in the TF tree. It is not added to the upstream core baseline. Disposition: move behavior/schema to a plugin or defer pending an owner-approved consumer and plugin migration contract. Its historical live hash remains documented and is recognized by the integration branch's compatibility registry, but its SQL is not in the fresh-database migration set.

`9003` restores company-scoped environments after upstream `0105_instance_scoped_environments`. The live table currently contains both `company_id` and `env_vars`, while upstream models instance-scoped environments. This cannot be resolved safely by copying either schema. Disposition: owner decision required / semantic merge. Its historical hash is recognized by the compatibility registry, but no reversal is applied and its SQL is not in the fresh-database migration set.

## Sustainable TF migration overlay

The current repository has one Drizzle migration directory and one journal. A separate directory for TF migrations would require a new migration-runner contract, separate history ordering, and fresh/existing-database bootstrap logic. It is not supported by the current runner.

The recommended strategy is a reserved post-upstream TF overlay in the existing directory: TF-owned core migrations use the `9000+` filename band, and a deterministic merge places all upstream entries first and the TF overlay entries last. The `migration-overlay.ts` helper and tests enforce that rule. `idx=224` is acceptable for this temporary integration baseline, but future upstream syncs must regenerate the single journal from the upstream entries plus the reserved overlay rather than treating `224` as a permanent slot. This avoids collisions when upstream adds `0224` or later entries.

Compared with manually re-appending files after every sync, the reserved overlay makes ownership and ordering explicit and mechanically testable. Compared with a distinct post-upstream directory, it works with the existing runner and preserves one hash-based history. The cost is that future sync tooling must deterministically rebuild the journal and keep overlay entries after all upstream entries.

Fresh-database behavior is tested by applying the current sequence and verifying the `9001` index. Existing-TF-database behavior is tested by recognizing the applied `9002`/`9003` hashes without making their SQL executable, preserving pending detection, and rejecting unknown history hashes visibly.

The migration safety checker reports the retained 9001 `CREATE UNIQUE INDEX` as a known-large-table warning (local sample 52,791 rows; estimated 13,197,750 rows). The exact SQL is preserved so its live hash remains unchanged; the reviewed finding is recorded in the repository safety baseline. The current runner executes migrations inside a transaction, so `CREATE UNIQUE INDEX CONCURRENTLY` is PostgreSQL-valid only outside the current runner transaction and is not substituted here. The baseline records review status, not production execution authorization.

## Shared-contract implications

- `SidebarBadges.agentOperations` is already represented by upstream's current shared/UI contract; TF's duplicate patch is replaceable.
- `execution-constraints.ts` is a TF-only canary policy covering environment minimization, secret rejection, path/write allowlists, no network/git mutation, and no task/agent creation. It is not equivalent to the upstream sandbox capability contract and remains a retain-core candidate.
- `work-contract.ts` is consumed by the TF Linear Sync plugin and should move to plugin-local code or a plugin-shared contract rather than remain in core.
