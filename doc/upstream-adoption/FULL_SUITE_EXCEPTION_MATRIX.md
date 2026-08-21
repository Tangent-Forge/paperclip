# Full-suite exception matrix

Candidate: `cc662d756ec23713710823bf7cff01b64c2f960e`.
Exact upstream comparison: `d1cd9c37f49e21e0f248918bce24cff137e3802d`.

Accepted disposition: **no TF-introduced regression has been demonstrated**.
The suite is qualified, not green. No assertion, timeout, retry, skip, or test
was weakened or removed.

## Aggregate results

The first aggregate run took `1241.28s` and ended `4867 pass / 2 fail / 5
skip` across 4874 tests. A later general-server aggregate completed `4869 pass
/ 0 fail / 5 skip` in `1231.08s`; later workspace/UI lanes retained the
exceptions below.

## Failures and dispositions

| File | Test/assertion | Candidate result | Exact upstream result / equivalent evidence | Isolated result | Classification | Blocking |
| --- | --- | --- | --- | --- | --- | --- |
| `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts` | `allows explicit proactive generic timer wakes without assigned issue work`; line 471 expects `countExecuteCallsForRun(run!.id)).toBe(1)` | Aggregate: `expected +0 to be 1`; received 0 | Exact upstream file `24/24` pass in `24.75s`; selected pair `2/2` pass in `11.24s` | Branch file `24/24` pass at `33.70s`, `23.47s`, `22.40s`, `23.95s`; seven-file serial set `315/315` | demonstrated nondeterministic test flake | Non-blocking for branch attribution; aggregate remains qualified |
| `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts` | `skips wakes before queueing when per-agent daily run cap is reached`; line 499 expects `mockAdapterExecute` not called | Aggregate: `vi.fn()` called once with timer/schedule/wake-on-demand payload | Exact upstream file and selected pair pass under the same conditions | Same branch repeats and serial neighbor set pass | demonstrated nondeterministic test flake | Non-blocking for branch attribution; aggregate remains qualified |
| `ui/src/components/OnboardingWizard.test.tsx` | storage-denial restore gate; line 387 expects `getItem` called | `12 pass / 1 fail`; `expected "getItem" to be called at least once` | Exact upstream full file also `12 pass / 1 fail`; selected upstream failed in `1.57s` | Candidate selected failed in `1.76s`; full file `1.63s` | upstream-existing | Non-blocking; no UI path changed |
| `packages/adapters/gemini-local/src/server/acp.test.ts` | `test_gemini_acp_seam_registers_workspace_sync_back` | Missing `/home/tfhub/.gemini/skills/paperclip*` during tar | Exact upstream same failure | Candidate Gemini lane had `21/23` pass; new helper/model/route tests pass | environmental | Non-blocking fixture failure |
| `packages/adapters/gemini-local/src/server/execute.remote.test.ts` | `pre-selects gemini-api-key auth in the managed HOME for sandbox execution` | `Could not determine remote file size for /remote/workspace/.paperclip-runtime/gemini/workspace-download.tar` | Exact upstream same failure | Same Gemini focused lane | environmental | Non-blocking remote mock failure |
| `packages/adapter-utils/src/sandbox-callback-bridge.test.ts` | queued request survives recovery 503 writes for later terminal 503 | `waitFor timed out` at source line 2373 | Exact upstream selected source equivalent passes | Branch selected source tests pass; no adapter-utils source changed | environmental/concurrency-dependent | Non-blocking, generated/parallel lane remains qualified |
| `packages/adapter-utils/dist/sandbox-callback-bridge.test.js` | same callback-bridge test in generated dist | `waitFor timed out` | Upstream source equivalent passes; generated-dist comparison not equivalent | Source isolation passes | environmental/concurrency-dependent | Non-blocking generated-dist exception |
| `packages/adapter-utils/dist/sandbox-managed-runtime.test.js` | runtime core free of Codex-specific literals | `ENOENT` for `dist/sandbox-managed-runtime.ts` | Generated-dist equivalent not retained; source path exists | Candidate does not change adapter-utils | parallel/generated-fixture defect | Non-blocking harness defect |
| `packages/adapter-utils/src/acpx-engine/execute.test.ts` | fingerprint changes with resolved env but not across wakes | expected unchanged fingerprint but received a different fingerprint (`b794...` vs `3a...` in one run) | Exact upstream selected source equivalent passes | Branch selected source reproduction passes | environmental/concurrency-dependent | Non-blocking; unchanged path |
| `packages/adapter-utils/dist/acpx-engine/execute.test.js` | same fingerprint test in generated dist | same expected/received fingerprint mismatch | Upstream source equivalent passes | Branch source isolation passes | environmental/concurrency-dependent | Non-blocking generated-dist exception |
| `packages/adapters/claude-local/dist/server/setup-token-parse.test.js` | setup-token prompt characterization fixture | `ENOENT` for `dist/server/__fixtures__/setup-token.md` | No separate clean-base generated-dist rerun retained; source unchanged | Claude: `438 pass / 2 skip` plus two generated-dist failures | parallel/generated-fixture defect | Non-blocking |
| `packages/adapters/claude-local/dist/server/setup-token-parse.test.js` | setup-token credential success fixture | `ENOENT` for `dist/server/__fixtures__/setup-token-success.md` | Same generated-dist evidence; source unchanged | Same Claude lane | parallel/generated-fixture defect | Non-blocking |

## Bounded heartbeat investigation

The failing file passed three repeated isolated branch runs, neighboring
heartbeat/session suites passed both normal-parallel and serial modes, the
seven-file serial set passed `315/315`, and the exact upstream base passed the
failing file and selected tests. The normal-parallel seven-file run produced
two different process-recovery failures (`heartbeat-process-recovery` lines
3534 and 6189); the serial run passed. These are independent concurrency
observations, not branch regressions.

Read-only host checks found soft `nofile=1024`, hard `1048576`,
`file-nr=15593 0 ...`, `/tmp` 51% full, 9% inodes used, and approximately 19
GiB available memory. No host-wide limit or production configuration changed.

## Final statement

No TF-introduced regression has been demonstrated. The PR must preserve this
matrix and must not claim “full suite green.”
