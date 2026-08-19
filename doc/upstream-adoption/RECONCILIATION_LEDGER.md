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
| Historical 9002/9003 hash recognition | move TF behavior to configuration/operations | Compatibility registry accounts for applied legacy hashes without replaying unresolved SQL |
| Active wakeup idempotency | retain TF core patch | Safe independent index; integrated as migration 9001 after upstream baseline |
| Evidence registry | move TF behavior to plugin | No core consumers; require plugin-owned migration/schema contract before migration |
| Environment tenancy | owner decision required | Live company-scoped shape conflicts with upstream instance-scoped model |
| Shared sidebar badge | upstream replaces TF implementation | Upstream exposes equivalent capability; verify `agentOperations` semantics |
| Canary execution constraints | retain TF core patch | Upstream sandbox contract does not enforce TF's exact env/path/network/task restrictions |
| Agent identity proof acceptance | defer | TF-only corrective-acceptance protocol depends on TF-specific Hermes/heartbeat/routes and is not present in upstream; retain the source checkout for a separately owned acceptance-control decision rather than partially porting it |
| Run-log credential scanner/quarantine | move TF behavior to configuration/operations | TF-only bounded scanner is an operational retention/quarantine control invoked by a script, not a Paperclip runtime contract; keep it outside synchronized product core until deployment ownership and alert routing are declared |
| Host/container/system metrics | move TF behavior to configuration/operations | TF-only Prometheus/system-health surface is deployment telemetry; upstream plugin metrics/tool-runtime health are the product-owned equivalents |
| Work contract/admission | move TF behavior to plugin | Linear Sync is the current consumer; remove core export only after plugin contract tests |
| Plugin host/session APIs | upstream replaces TF implementation | Upstream now provides agent sessions, streaming, orchestration, SDK clients, and UI slots; verify TF plugins against it |
| Authorization and authenticated session actor resolution | upstream replaces TF implementation | Clean upstream retains the richer Better Auth/session/membership/grant boundary that TF's reduced middleware and authorization service removed; focused baseline tests pass |
| Interaction resolver governance and addressee semantics | upstream replaces TF implementation | Upstream schema/service/routes retain resolver policy provenance, addressee, and continuation safeguards removed by TF; do not port the reduced TF version |
| Adapter session compaction registrations | move TF behavior to plugin | TF-only `acpx_local`, `kimi_local`, and `qwen_local` registrations are adapter-specific and should follow their plugin/adapter contracts |
| TF Brain, Linear Sync, Council intake | move TF behavior to plugin | Existing plugin boundaries are the intended ownership model |
| Additional adapters | move TF behavior to plugin | Prefer upstream adapter/plugin contracts; retain only demonstrated provider requirements |
| Gemini/Antigravity adapter compatibility | retain TF core patch | Upstream ACP/CLI remains authoritative; the bounded Antigravity lane adds only `agy` model/session/owned-flag compatibility and config-aware model discovery, with focused tests and identical upstream fixture evidence |
| UI Decisions/task chat/inbox | upstream replaces TF implementation | Upstream has current task chat, interaction ordering, Decisions, resolver/queue, inbox policy, archive, and dismissal behavior; no TF duplicate is retained |
| Runtime/observability | move TF behavior to configuration/operations | Operational controls should not become product core without deployment ownership |
| Guardian/cutover controls | move TF behavior to configuration/operations | Delivery governance remains outside Paperclip product synchronization |

## Hard stops

- No live restart, deployment, cutover, migration, or process-unit change is authorized by this ledger.
- No blanket `ours`/`theirs` conflict resolution is permitted.
- No TF implementation is retained solely because it exists; retention requires a demonstrated upstream gap.
- Before merge, attach the exact resulting baseline SHA, retained core-delta manifest, replaced/removed patches, plugin/config migrations, unresolved semantic conflicts, security fixes, database reconciliation, complete tests, Companion delta, and cutover plan.

## Authorization / interactions / sessions phase

The clean upstream baseline was tested with the focused actor/authentication, authorization, interaction, adapter-session, and workspace-session suites: 9 test files and 367 tests passed in 23.26s. The source comparison against TF origin shows that TF removed upstream capabilities in the corresponding middleware, authorization service, interaction schema/service/UI, and auth client. Those removals are not a demonstrated TF requirement and are retired by adoption of upstream.

The only additive session difference identified in TF is registration for three TF-only adapter types (`acpx_local`, `kimi_local`, `qwen_local`). It is not copied into core; it remains a plugin/adapter-owned migration item for the later adapter/runtime phase.

## Plugin SDK / host-services phase

The upstream plugin SDK and host were retained wholesale. The TF fork's SDK/host changes were not copied because upstream provides the newer capability-scoped RPC, invocation-company scope, environment lifecycle, database namespace, authorization, and execution-workspace contracts.

The three meaningful TF plugin packages were added as plugin-owned code and validated against that SDK:

- `paperclip-plugin-linear-sync`: typecheck, build, and 20 tests pass. Its work-contract implementation is local to the plugin, and route company resolution was adapted to the upstream-supported body/query forms rather than expanding the core SDK with a path resolver.
- `paperclip-plugin-council-email-intake`: typecheck, build, and 6 tests pass. Its external email side effects remain configuration/deployment gated.
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
