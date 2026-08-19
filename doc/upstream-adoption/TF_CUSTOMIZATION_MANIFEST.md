# TF customization manifest and reconciliation ledger

Baseline comparison:

- upstream: `d1cd9c37f49e21e0f248918bce24cff137e3802d`
- TF origin: `61bd44a07b53245c88d7158c073481e33b0bdede`
- merge base: `5c117257845a832c94311422d53a1026c05b806a`
- TF-only commits: `223`
- upstream-only commits: `959`
- TF-only changed paths: `243`
- upstream-only changed paths: `2947`
- paths changed on both sides: `188`

The complete raw path inventory is reproducible from the preserved checkout with:

```bash
git -C /home/tfhub/paperclip-devin-adapter-work diff --name-status upstream/master origin/master
git -C /home/tfhub/paperclip-devin-adapter-work diff --name-status 5c117257845a832c94311422d53a1026c05b806a origin/master
```

The reconciliation ledger below records the meaningful TF customizations identified in phase 1. Unreviewed path-level changes remain `defer`; they are not implicitly retained.

| TF customization | Source paths / area | Disposition | Current evidence / next gate |
| --- | --- | --- | --- |
| Active wakeup idempotency | `packages/db/src/migrations/9001_agent_wakeup_active_idempotency_uq.sql`; `packages/db/src/schema/agent_wakeup_requests.ts` | retain TF core patch | Integrated beside upstream review-path guard; focused migration tests pass; live read-only verification found the exact unique partial index and zero duplicate active groups; no DDL executed |
| Evidence provenance registry | `packages/db/src/migrations/9002_evidence_provenance_registry.sql`; `packages/db/src/schema/evidence_registry.ts` | move TF behavior to plugin / defer | No TF application consumer found; define plugin-owned schema namespace before migration |
| Company-scoped environments / 9003 | `packages/db/src/migrations/9003_restore_company_scoped_environments.sql`; `packages/db/src/schema/environments.ts` | upstream replaces TF implementation | Owner approved upstream instance-scoped identity/defaults; preserve live company-scoped leases, secret/provider bindings, and audit attribution through supported contracts; historical 9003 hash remains compatibility-only and SQL stays out of fresh core |
| Historical migration identity compatibility | `packages/db/src/migration-history-compat.ts`; `packages/db/src/client.ts` | move TF behavior to configuration/operations | Recognizes applied 9002/9003 hashes without making unresolved SQL runnable on fresh databases |
| Authorization and authenticated session actor resolution | `server/src/auth/better-auth.ts`; `server/src/middleware/auth.ts`; `server/src/routes/authz.ts`; `server/src/services/authorization.ts`; `ui/src/api/auth.ts` | upstream replaces TF implementation | Upstream retains the richer session/membership/grant boundary that the TF branch removed; focused authorization/session tests pass on the clean upstream baseline |
| Interaction resolver governance and addressee semantics | `packages/db/src/schema/issue_thread_interactions.ts`; `server/src/services/issue-thread-interactions.ts`; interaction routes/UI | upstream replaces TF implementation | Upstream includes resolver-policy provenance, addressee, continuation, and related migration history; TF's version removed those safeguards and is not retained |
| Adapter session compaction registrations | `packages/adapter-utils/src/session-compaction.ts` | move TF behavior to plugin | TF adds `acpx_local`, `kimi_local`, and `qwen_local` session declarations; keep adapter-owned behavior with the corresponding adapter/plugin contract rather than weakening upstream core |
| Canary execution policy | `packages/shared/src/execution-constraints.ts` and tests; `packages/shared/src/validators/agent.ts`; `packages/adapters/codex-local/src/server/codex-args.ts`; `packages/adapters/codex-local/src/server/execute.ts` | retain TF core patch | Upstream execution-target/session path retained; TF policy helpers, strict validation, constrained args, minimal-env mode, workspace allowlist, and pre/post write/git checks semantically merged; shared 12 tests and Codex 14 tests pass |
| Agent identity proof acceptance | `server/src/services/agent-identity-proof.ts`; Hermes/heartbeat/issues routes | defer | TF-only acceptance protocol coupled to removed TF adapter/heartbeat/routes; do not partially port without an owner-approved acceptance contract and end-to-end test fixture |
| Run-log credential scanner/quarantine | `server/src/services/run-log-security-scanner.ts`; `scripts/paperclip-run-log-security-scan.mjs` | move TF behavior to configuration/operations | Bounded operational scan/quarantine; no upstream product equivalent required for the core baseline; deployment owner and alert path remain to be declared |
| Host/container/system metrics | `server/src/services/system-metrics.ts`; health/Prometheus wiring | move TF behavior to configuration/operations | Deployment telemetry, not core Companion behavior; upstream plugin metrics and tool-runtime health remain the product surfaces |
| Work admission/delivery contract | `packages/plugins/paperclip-plugin-linear-sync/src/work-contract.ts` | move TF behavior to plugin | The implementation is plugin-local on the upstream baseline; it is not added to shared core or the SDK |
| Sidebar agent-operation badge | `packages/shared/src/types/sidebar-badges.ts`; `server/src/services/sidebar-badges.ts`; UI consumers | upstream replaces TF implementation | Upstream has the capability surface; compare semantics and remove duplicate only after tests |
| TF Brain UI/worker | `packages/plugins/paperclip-plugin-tf-brain/**` | move TF behavior to plugin | Added as a plugin package and typechecks/builds against the upstream SDK; UI slot/installation acceptance remains |
| Linear Sync | `packages/plugins/paperclip-plugin-linear-sync/**` | move TF behavior to plugin | Added as a plugin package; work contract is plugin-local and company resolution uses upstream body/query contract; 20 tests pass |
| Council email intake | `packages/plugins/paperclip-plugin-council-email-intake/**` | move TF behavior to plugin | Added as a plugin package; 6 tests pass; external side effects remain owner/deployment gated |
| Devin/local provider and additional local adapters | `packages/adapters/devin-local/**`, `kimi-local/**`, `qwen-local/**`, `provider-router-local/**`, `tf-gpu-worker/**`, `mcp-bridge/**`; adapter session-compaction registrations | move TF behavior to plugin / defer | Not copied into core. Re-adopt only with provider/runtime evidence and an upstream SDK/host contract; no TF adapter implementation is retained solely because it exists |
| Gemini/Antigravity adapter compatibility | `packages/adapters/gemini-local/src/index.ts`; `server/src/adapters/gemini-models.ts`; Gemini execution/ACP selection and model route | retain TF core patch | Upstream Gemini ACP/CLI path remains authoritative. The bounded merge adds only command-specific Antigravity model aliases, `--conversation` mapping, owned-flag sanitization, implicit-CLI routing, and config-aware `agy models` discovery; focused helper/model/ACP tests pass, while two pre-existing remote fixture tests fail identically on upstream |
| Runtime/observability/health additions | `server/src/services/system-metrics.ts`, `server/src/telemetry/trace-context.ts`, health tests, `infra/observability/**` | move TF behavior to configuration/operations / defer | Establish deployment ownership and operational need before core retention |
| Guardian/release/cutover scripts | `scripts/guardian-verify.sh`, `scripts/paperclip-post-cutover-verify.sh`, `scripts/sync-upstream.sh`, `.tf-deploy/**` | move TF behavior to configuration/operations | These are delivery controls, not Paperclip product core |
| TF docs/evals/skills | `doc/**`, `docs/**`, `evals/**`, `skills/**`, `system-health/**` | defer | Reconcile only after product/security implementation decisions |

No disposition authorizes merge to TF master. Each remaining `semantic merge required`, `owner decision required`, and `defer` row is a pre-merge stop condition until resolved and tested. 9003's owner decision is resolved for the synchronized baseline, but its production retirement plan still requires separate migration/cutover approval.

The 9003 retirement design is in
`doc/upstream-adoption/ENVIRONMENT_9003_RETIREMENT_PLAN.md`. The full qualified
test exception matrix is in `doc/upstream-adoption/FULL_SUITE_EXCEPTION_MATRIX.md`.
