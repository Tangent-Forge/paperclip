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
