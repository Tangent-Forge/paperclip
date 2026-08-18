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
| Active wakeup idempotency | `packages/db/src/migrations/9001_agent_wakeup_active_idempotency_uq.sql`; `packages/db/src/schema/agent_wakeup_requests.ts` | retain TF core patch | Integrated beside upstream review-path guard; migration test and live-schema dry-run required |
| Evidence provenance registry | `packages/db/src/migrations/9002_evidence_provenance_registry.sql`; `packages/db/src/schema/evidence_registry.ts` | move TF behavior to plugin / defer | No TF application consumer found; define plugin-owned schema namespace before migration |
| Company-scoped environments | `packages/db/src/migrations/9003_restore_company_scoped_environments.sql`; `packages/db/src/schema/environments.ts` | owner decision required | Live has company scope plus upstream env_vars; requires data/tenant decision |
| Canary execution policy | `packages/shared/src/execution-constraints.ts` and tests; adapter-utils/server enforcement | retain TF core patch | Upstream sandbox contract is not equivalent; security review required |
| Work admission/delivery contract | `packages/shared/src/work-contract.ts`; `packages/plugins/paperclip-plugin-linear-sync/src/work-contract.ts` | move TF behavior to plugin | Linear Sync is the consumer; reconcile public SDK export before removal |
| Sidebar agent-operation badge | `packages/shared/src/types/sidebar-badges.ts`; `server/src/services/sidebar-badges.ts`; UI consumers | upstream replaces TF implementation | Upstream has the capability surface; compare semantics and remove duplicate only after tests |
| TF Brain UI/worker | `packages/plugins/paperclip-plugin-tf-brain/**` | move TF behavior to plugin | Already packaged as a plugin; reconcile SDK/UI slots with upstream plugin host |
| Linear Sync | `packages/plugins/paperclip-plugin-linear-sync/**` | move TF behavior to plugin | Existing plugin boundary; validate company scoping and migration ownership |
| Council email intake | `packages/plugins/paperclip-plugin-council-email-intake/**` | move TF behavior to plugin | Existing plugin boundary; validate external side effects and tenant scope |
| Devin/local provider and additional local adapters | `packages/adapters/devin-local/**`, `kimi-local/**`, `qwen-local/**`, `provider-router-local/**`, `tf-gpu-worker/**`, `mcp-bridge/**` | move TF behavior to plugin / defer | Use upstream plugin SDK/host services where equivalent; adapter-specific semantic review pending |
| Gemini/local adapter changes | `packages/adapters/gemini-local/**`; `server/src/adapters/gemini-models.ts` | semantic merge required | Preserve dirty adapter worktree separately; upstream adapter/session behavior must be compared |
| Runtime/observability/health additions | `server/src/services/system-metrics.ts`, `server/src/telemetry/trace-context.ts`, health tests, `infra/observability/**` | move TF behavior to configuration/operations / defer | Establish deployment ownership and operational need before core retention |
| Guardian/release/cutover scripts | `scripts/guardian-verify.sh`, `scripts/paperclip-post-cutover-verify.sh`, `scripts/sync-upstream.sh`, `.tf-deploy/**` | move TF behavior to configuration/operations | These are delivery controls, not Paperclip product core |
| TF docs/evals/skills | `doc/**`, `docs/**`, `evals/**`, `skills/**`, `system-health/**` | defer | Reconcile only after product/security implementation decisions |

No disposition authorizes merge to TF master. Each `semantic merge required`, `owner decision required`, and `defer` row is a pre-merge stop condition until resolved and tested.
