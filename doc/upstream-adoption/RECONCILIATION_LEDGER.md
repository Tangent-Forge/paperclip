# Upstream-adoption reconciliation ledger

This ledger is the control record for the preparation branch. Every meaningful TF customization must end with exactly one disposition from the approved set. Disposition and delivery lane are separate: an item may be intentionally deferred from synchronized core and tracked after source merge, while production-dependent work remains a cutover blocker. The explicit source-merge and cutover gates below are authoritative.

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
| Historical 9002/9003 hash recognition | move TF behavior to configuration/operations | Compatibility registry accounts for applied legacy hashes without replaying unresolved SQL |
| Active wakeup idempotency | retain TF core patch | Safe independent index; integrated as migration 9001 after upstream baseline |
| Evidence registry | move TF behavior to plugin | 9002 has no core consumer; historical-hash compatibility remains, absent SQL is not executable, and a plugin-owned schema is a tracked post-merge follow-up only when a real consumer exists |
| Environment tenancy / 9003 retirement | upstream replaces TF implementation | Owner approved upstream instance scope; preserve historical 9003 hash, exclude 9003 SQL from fresh core, and execute only the separately approved retirement plan |
| Shared sidebar badge | upstream replaces TF implementation | Upstream exposes equivalent capability; verify `agentOperations` semantics |
| Canary execution constraints | retain TF core patch | Upstream sandbox contract does not enforce TF's exact env/path/network/task restrictions |
| Agent identity proof acceptance | defer | Tracked post-merge follow-up, not a source-merge blocker. Do not partially port the TF-only Hermes/heartbeat/routes protocol; perform a read-only live-dependency check before cutover and block cutover only if a required live flow depends on it |
| Run-log credential scanner/quarantine | move TF behavior to configuration/operations | Tracked post-merge outside product core. Production cutover requires a named owner, invocation schedule, retention/quarantine behavior, and alert route or an explicit retirement decision |
| Host/container/system metrics | move TF behavior to configuration/operations | Tracked post-merge outside product core. Production cutover requires minimum health/metrics ownership and the readbacks needed for acceptance and rollback |
| Work contract/admission | move TF behavior to plugin | Linear Sync is the current consumer; remove core export only after plugin contract tests |
| Plugin host/session APIs | upstream replaces TF implementation | Upstream now provides agent sessions, streaming, orchestration, SDK clients, and UI slots; verify TF plugins against it |
| Authorization and authenticated session actor resolution | upstream replaces TF implementation | Clean upstream retains the richer Better Auth/session/membership/grant boundary that TF's reduced middleware and authorization service removed; focused baseline tests pass |
| Interaction resolver governance and addressee semantics | upstream replaces TF implementation | Upstream schema/service/routes retain resolver policy provenance, addressee, and continuation safeguards removed by TF; do not port the reduced TF version |
| Adapter session compaction registrations | move TF behavior to plugin | TF-only `acpx_local`, `kimi_local`, and `qwen_local` registrations are adapter-specific and should follow their plugin/adapter contracts |
| TF Brain, Linear Sync, Council intake | move TF behavior to plugin | Existing plugin boundaries are the intended ownership model |
| Additional adapters | move TF behavior to plugin | Tracked post-merge; prefer upstream adapter/plugin contracts and retain only demonstrated provider requirements. Any adapter type assigned to a live required agent must be ready before cutover |
| Gemini/Antigravity adapter compatibility | retain TF core patch | Upstream ACP/CLI remains authoritative; the bounded Antigravity lane adds only `agy` model/session/owned-flag compatibility and config-aware model discovery, with focused tests and identical upstream fixture evidence |
| UI Decisions/task chat/inbox | upstream replaces TF implementation | Upstream has current task chat, interaction ordering, Decisions, resolver/queue, inbox policy, archive, and dismissal behavior; no TF duplicate is retained |
| Runtime/observability | move TF behavior to configuration/operations | Operational controls should not become product core without deployment ownership |
| Guardian/cutover controls | move TF behavior to configuration/operations | Delivery governance remains outside Paperclip product synchronization |

## Advanced-master reconciliation and PR #94 remediation

The branch was first reconciled against `origin/master` at
`6c3c8328f5dcd2a00cd1d35412e9483a17fc757e` using a normal semantic merge
preparation, then re-reconciled against the advanced `origin/master` at
`31aea4f4f5281073d68a1684cacadf75d1c817c8` after upstream #98 and #97 landed.
The overlapping surfaces were classified as follows:

- Triage admission and its recovery documentation: current master wins.
- Linear admission constants and tests: semantic merge; `Triage` is now the
  single admission state used by both the plugin worker and work-contract
  evaluator.
- The obsolete shared `packages/shared/src/work-contract.ts` copy: PR-local
  plugin implementation wins; the shared copy remains deleted.
- Obsolete TF plugin-route authorization tests: PR-local upstream-compatible
  route behavior wins; the removed patch-route assertions were not restored.
- `doc/DEVELOPING.md`: semantic merge retaining the synchronized upstream
  guidance and the advanced-master plugin/Triage admission guidance.
- Advanced-master plugin materialization, Linear Sync `0.1.1`/Triage admission,
  and TF Brain route/manifest updates are retained as upstream changes. The
  upstream shared `packages/shared/src/work-contract.ts` copy remains excluded
  because the synchronized runtime imports the plugin-owned contract; retaining
  both would reintroduce an unused duplicate with different ownership. The
  plugin-owned contract is reconciled to the single Triage constant.

The reviewed PR findings are remediated in the remediation candidate represented
by the subsequent PR head; the validation and delivery status below are kept
separate from the earlier reviewed head:

- Linear Sync and Council Email Intake opt into `multiCompanyConfig`, retain
  configured company scopes, call `ctx.config.get(companyId)`, and resolve
  secrets with `{ companyId, configPath }`. Scheduled, webhook, data, and API
  paths fail closed on missing, mismatched, or unconfigured company scope.
- Council's migration objects are qualified into the deterministic namespace
  `plugin_council_email_intake_f6365ccdd0`; the plugin README documents fresh
  install, upgrade checksum, disable/uninstall, and purge semantics.
- Gemini/Antigravity discovery cache entries are typed and partitioned by
  company, agent principal, provider-account/config fingerprint, command, and
  HOME. Unversioned secret bindings are non-cacheable; expiration and
  credential-scope partition tests are included. No raw secret is placed in a
  cache key or log.
- Real host-boundary tests cover valid scoped config/secret reads, missing and
  wrong-company denial, proactive configured-company scopes, and per-company
  lookup behavior. The worker-manager subprocess suite remains an environment
  exception on this host because its fixture workers exit with code 0 before
  initialization; direct host-handler and plugin-boundary suites remain
  separately recorded.
- General aggregate validation completed with 279 passed, 38 failed, 100
  skipped test files and 2,828 passed, 287 failed, 1,768 skipped tests out of
  4,883, plus 144 errors. The failures are dominated by this host's denied TCP
  `listen` operations and related child-worker startup behavior. The serialized
  lane stopped on the first affected suite with 1 failed file / 10 failed tests
  and the same `listen EPERM` signature. This is qualified environmental
  evidence, not a green full-suite result.

## Hard stops

- No live restart, deployment, cutover, migration, or process-unit change is authorized by this ledger.
- No blanket `ours`/`theirs` conflict resolution is permitted. The separately approved `-s ours` ancestry-only bridge is a history operation whose zero-file tree identity was proven; it is not permission to resolve source conflicts with ours/theirs.
- No TF implementation is retained solely because it exists; retention requires a demonstrated upstream gap.
- Before merge, attach the exact resulting baseline SHA, retained core-delta manifest, replaced/removed patches, plugin/config migrations, unresolved semantic conflicts, security fixes, database reconciliation, complete tests, Companion delta, and cutover plan.

## Ancestry bridge

The approved history-only bridge is
`76e37dfd0ee9f729d00e2175d35c30d2f3c75a4f` with first parent
`551158d8c3ac548be15d7039bc21f63b8154e279`, second parent
`61bd44a07b53245c88d7158c073481e33b0bdede`, and tree
`1fd6399a65bfc83f87e3e469605ca7ec6a04c5a2`. It adds, deletes, or modifies no
files. The upstream base `d1cd9c37f49e21e0f248918bce24cff137e3802d`
and old TF master are both ancestors. This bridge does not authorize a PR
merge, deployment, migration, or cutover.

## Delivery-gate classification

### PR source-merge blockers

- complete the PR template, public issue/inline issue description, and
  dedup-search evidence;
- obtain an approved lockfile synchronization strategy or exception without
  restoring the obsolete TF lockfile merely to satisfy CI;
- rerun or diagnose the failed `commitperclip PR Review` on the exact head;
- obtain exact-head review and preserve the qualified, not-green, test status;
- keep the PR draft until those gates and the final source-work inventory are
  accepted.

9002 evidence-registry ownership, identity-proof acceptance, scanner/metrics
product ownership, and additional adapters are tracked post-merge follow-ups;
they are not source-merge blockers.

### Production-cutover blockers

- execute no 9003 DDL/remapping until the transformed-clone dry run, complete
  reference inventory, lease/attribution proof, provider/secret isolation,
  metadata handling, index transition, rollback rehearsal, and separate
  production-write approval are complete;
- verify whether live flows require identity-proof acceptance or any omitted
  adapter and provide every live-required capability before deployment;
- preserve scanner/quarantine and minimum observability continuity through
  named operational ownership or an explicitly approved retirement;
- produce the exact deployment artifact/SHA, backup, concurrency/maintenance
  plan, health/acceptance checks, rollback triggers, and separate cutover
  approval.

## Owner decision: 9003 retirement

On 2026-08-19 the owner approved adoption of upstream's instance-scoped
environment model for the synchronized baseline. The approved contract is:

- Paperclip environment identity and the default environment may be
  instance-scoped.
- Provider credentials and secret bindings remain company-scoped.
- Execution leases, accounting, activity, and audit attribution remain
  company-scoped.
- Company-specific provider configuration/provisioning remains representable
  through supported plugin/provider/configuration contracts.
- Generic environment config/env-vars and row identity need not remain
  independently selectable per company without a demonstrated future need.

9003 is therefore retired as retained TF core schema semantics. Its historical
hash remains recognized for the existing live database, its SQL is excluded
from the fresh synchronized core migration set, and no production schema/data
operation is authorized by this decision.

The specific design is documented in
`doc/upstream-adoption/ENVIRONMENT_9003_RETIREMENT_PLAN.md`. The current
read-only inventory found the older live row
`0de79471-f411-4868-921f-84eff760ab86` with the instance-settings default and
25,811 leases, and the newer row
`c90f52fa-0dfe-4ec3-9f0a-5e026ee37d71` with 17 leases. The previously recorded
25,805 lease baseline has advanced under the still-running live process; the
retirement plan preserves every row present at the actual cutover, not a stale
hard-coded count.

## Authorization / interactions / sessions phase

The clean upstream baseline was tested with the focused actor/authentication, authorization, interaction, adapter-session, and workspace-session suites: 9 test files and 367 tests passed in 23.26s. The source comparison against TF origin shows that TF removed upstream capabilities in the corresponding middleware, authorization service, interaction schema/service/UI, and auth client. Those removals are not a demonstrated TF requirement and are retired by adoption of upstream.

The only additive session difference identified in TF is registration for three TF-only adapter types (`acpx_local`, `kimi_local`, `qwen_local`). It is not copied into core; it remains a plugin/adapter-owned migration item for the later adapter/runtime phase.

## Plugin SDK / host-services phase

The upstream plugin SDK and host were retained wholesale. The TF fork's SDK/host changes were not copied because upstream provides the newer capability-scoped RPC, invocation-company scope, environment lifecycle, database namespace, authorization, and execution-workspace contracts.

The three meaningful TF plugin packages were added as plugin-owned code and validated against that SDK:

- `paperclip-plugin-linear-sync`: typecheck, build, and 22 tests pass. Its work-contract implementation is local to the plugin, its Triage admission constant is reconciled with the evaluator, and its scheduled/webhook/API paths use explicit company-scoped host services.
- `paperclip-plugin-council-email-intake`: typecheck, build, and 8 tests pass. Its migration is namespace-qualified and its webhook/config/secret access is explicit and company-scoped; external email side effects remain configuration/deployment gated.
- `paperclip-plugin-tf-brain`: typecheck and build pass. UI/runtime acceptance and gbrain connectivity remain separate gates.

No plugin was installed, enabled, or executed against the live Paperclip process as part of this work.

## Decisions / task-chat / inbox phase

The upstream UI baseline passed the focused suite: 9 files and 128 tests in 3.80s. The TF branch's reduced or alternate Decision cards, task-chat interaction components, and inbox helpers are therefore retired in favor of upstream. No first-class Companion UI implementation is added where upstream already supplies the capability.

## Adapters / runtime / execution-constraints phase

The current upstream adapter execution path was retained and semantically merged with the bounded TF execution-constraints core. The retained delta is deliberately narrow:

- `packages/shared/src/execution-constraints.ts` provides the typed policy helpers and fail-closed path/environment/git checks.
- `packages/shared/src/validators/agent.ts` validates strict constraint shape and canary invariants.
- `packages/adapters/codex-local/src/server/codex-args.ts` blocks bypass/danger-full-access/search widening and adds the constrained Codex sandbox configuration.
- `packages/adapters/codex-local/src/server/execute.ts` now applies the workspace allowlist, minimal environment mode, local-only write/git policy, pre-run/post-run porcelain comparison, and upstream execution-target process path.

Validation for this phase: shared typecheck plus 12 focused helper tests passed; Codex adapter typecheck plus 14 argument-policy tests passed; repository-wide typecheck and build pass. The aggregate test result remains qualified below because of demonstrated upstream/pre-existing failures.

The TF-only `devin-local`, `kimi-local`, `qwen-local`, provider-router, GPU-worker, MCP-bridge, and adapter-specific session-compaction additions are not copied into Paperclip core. They remain plugin/adapter migration candidates and must prove a provider/runtime requirement against the upstream SDK before adoption. The TF-only identity-proof, run-log scanner, and host metrics services are separately dispositioned above; no partial server route or heartbeat port was introduced.

## Aggregate heartbeat failure investigation (2026-08-18)

The branch aggregate run was executed with `pnpm test` from this worktree at 16:48:52. It ran for 1241.28s and ended with:

```text
Test Files  1 failed | 414 passed | 1 skipped (416)
Tests       2 failed | 4867 passed | 5 skipped (4874)
```

The two failures were both in `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`:

1. `heartbeat stale queued-run invalidation > allows explicit proactive generic timer wakes without assigned issue work`

   ```text
   AssertionError: expected +0 to be 1 // Object.is equality

   - Expected
   + Received

   - 1
   + 0

   ❯ src/__tests__/heartbeat-stale-queue-invalidation.test.ts:471:46
   469|     expect(run).not.toBeNull();
   470|     await waitForCondition(async () => countExecuteCallsForRun(run!.id…
   471|     expect(countExecuteCallsForRun(run!.id)).toBe(1);
      |                                              ^
   472|   });
   ```

2. `heartbeat stale queued-run invalidation > skips wakes before queueing when per-agent daily run cap is reached`

   ```text
   AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times

   Received:
   1st vi.fn() call:
   [call object; wakeSource timer, wakeTriggerDetail schedule, maxConcurrentRuns=1, wakeOnDemand=true]

   ❯ src/__tests__/heartbeat-stale-queue-invalidation.test.ts:499:36
   497|     expect(run).toBeNull();
   498|     expect(mockAdapterExecute).not.toHaveBeenCalled();
      |                                ^
   499|   });
   ```

The aggregate output also included the suite's normal fixture logs (adapter loading, queue/liveness notices, and expected environment/configuration failure fixtures); no production action was performed.

### Bounded rerun matrix

| Environment / mode | Result | Timing / detail |
| --- | --- | --- |
| Branch, failing file isolated, normal Vitest execution | pass | 24/24; 33.70s; first rerun |
| Branch, failing file isolated, repeat 1 | pass | 24/24; 23.47s |
| Branch, failing file isolated, repeat 2 | pass | 24/24; 22.40s |
| Branch, failing file isolated, repeat 3 | pass | 24/24; 23.95s |
| Branch, six nearest heartbeat/session neighbors, normal parallel | pass | 159 passed, 132 skipped; 11.24s |
| Branch, same six neighbors, `--no-file-parallelism --maxWorkers=1` | pass | 159 passed, 132 skipped; 10.65s |
| Branch, failing file plus six neighbors, normal parallel | partial failure unrelated to stale-queue file | 313 passed, 2 failed; 125.88s; both failures were in `heartbeat-process-recovery.test.ts` |
| Branch, failing file plus six neighbors, serial | pass | 315/315; 114.15s |
| Exact upstream base `d1cd9c37f49e21e0f248918bce24cff137e3802d`, full failing file | pass | 24/24; 24.75s |
| Exact upstream base, the two formerly failing tests selected by name | pass | 2/2; 11.24s; remaining 22 skipped by name filter |

The combined normal-parallel neighbor run exposed two separate process-recovery failures, not the original stale-queue failures: `heartbeat-process-recovery.test.ts:3534` received `undefined` instead of `null`, and `heartbeat-process-recovery.test.ts:6189` received no liveness wake. The same seven-file set passed serially. These are recorded as independent broader-suite concurrency/environment observations, not as regressions in this DB branch.

### Resource check and disposition

Read-only host indicators after the runs were: soft `nofile=1024`, hard `nofile=1048576`, `/proc/sys/fs/file-nr=15593 0 9223372036854775807`, `/tmp` 51% full with 9% inodes used, 19 GiB available memory, and three file descriptors in the inspection shell. No host-wide limit or production configuration was changed. The prior FD-exhaustion condition was not present at inspection time, but the evidence does not prove it was absent during the original aggregate run.

Both original stale-queue failures have disposition **demonstrated nondeterministic test flake** for this integration decision: they occurred once in the 4,867-test aggregate, passed three isolated branch repeats, passed in the branch's normal and serial targeted-neighbor matrices, and passed on the exact upstream base. There is no changed file under `server/` or in the heartbeat implementation; the current branch delta is DB/client/compatibility bookkeeping and reconciliation documentation. The evidence exonerates the current branch from these two failures, but does not establish that the full aggregate suite is green or prove a single causal trigger for the aggregate-only event. No assertion, timeout, retry, or flake marker was changed.

### Subsequent aggregate and focused validation

A later repository aggregate run on this branch completed the general-server lane with:

```text
Test Files  415 passed | 1 skipped (416)
Tests       4869 passed | 5 skipped (4874)
Duration    1231.08s
```

The aggregate then entered the UI workspace lane and reported one failure before its terminal output became unavailable:

```text
OnboardingWizard restore-gate (stale localStorage across accounts) > renders instead of throwing when the browser denies storage access
AssertionError: expected "getItem" to be called at least once
ui/src/components/OnboardingWizard.test.tsx:387
```

The complete affected file reproduced exactly as 12 passed / 1 failed on both the branch and exact upstream base. The selected test failed in 1.76s on the branch and 1.57s on upstream; the complete file took 1.63s and 1.66s respectively. Disposition: **upstream/pre-existing failure**. No UI file was changed by this reconciliation.

The Gemini semantic merge retained upstream ACP and CLI behavior and added only the Antigravity compatibility boundary: command-specific model aliases, `--conversation` session mapping, owned-flag sanitization, implicit CLI routing when `command=agy`, and config-aware `agy models` discovery. Its focused helper/model/ACP tests passed. Two existing remote fixture tests failed identically on branch and upstream (missing `/home/tfhub/.gemini/skills/*` fixture paths and a mocked remote tar size lookup), so they are classified as **environmental/fixture failures**, not branch regressions. The repository-wide typecheck and build both passed after the merge. No production process, database, or deployment was changed.

The first workspace-B attempt also surfaced a compatibility-registry gap in the generated DB test copy: the upstream legacy `0136` fixture hash was not recognized. The source and generated DB implementations now recognize that hash as the historical filename `legacy 0136_built_in_managed_resources.sql`, preserving `0140_built_in_managed_resources.sql` as pending. The focused source DB migration/client tests pass 21/21, and the DB package was rebuilt. The exact two TF-only hash registry remains unchanged and unknown hashes still fail visibly.

The adapter-utils portion of workspace-B reported five failures in normal project execution: two generated-dist/source callback-bridge timeout observations, one generated-dist source-file fixture mismatch, and two generated-dist/source ACP session-fingerprint assertions. The two changed-path-independent source assertions pass in isolation on both the branch and exact upstream base; the generated-dist failures are stale/fixture-specific. Disposition: **environmental/concurrency-dependent validation failures**, not branch regressions. No adapter-utils source was changed.

The remaining independent workspace-B projects were run directly after the DB package rebuild: shared `58 files / 516 tests` passed; skills-catalog `5 / 20` passed; DB `57 / 229` passed with 8 skips; openclaw `4 / 26` passed; opencode `14 / 84` passed; plugin SDK `6 / 45` passed; and create-paperclip-plugin `1 / 2` passed. Claude reported `27 files`, `438 passed / 2 skipped`, plus two generated-dist setup-token fixture failures because `dist/server/__fixtures__/setup-token*.md` is absent; no Claude source was changed. The aggregate therefore remains explicitly qualified rather than reported as fully green.
