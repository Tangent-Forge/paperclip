# TFOS execution loop: current state

Last checked: 2026-08-26

This is an operational description of the Paperclip execution path as implemented
in this checkout. It distinguishes verified code and run metadata from things that
must be checked against the live control plane.

## Dispatch path

```text
Backlog/todo issue
  -> assigned to an agent (board or authorized API actor)
  -> issue checkout establishes the active assignment
  -> assignment wake is queued
  -> heartbeat run starts with invocationSource=assignment
  -> workspace runtime resolves the configured execution workspace
  -> adapter receives PAPERCLIP_WORKSPACE_CWD and executes
  -> run status and issue status are recorded
  -> a request to set status=done passes the TFOS closure guard
```

The relevant implementation points are:

- `server/src/routes/issues.ts` owns assignment, checkout-facing issue changes,
  and the `PATCH /api/issues/:id` close transition.
- `server/src/services/issue-assignment-wakeup.ts` queues the assignment wake.
- `server/src/services/heartbeat.ts` owns heartbeat-run execution and recording.
- `server/src/services/workspace-runtime.ts` provisions and validates
  `git_worktree` execution workspaces. A run is isolated only when its workspace
  strategy and recorded `worktreePath` prove it; a branch name alone is not proof.
- `server/src/services/tfos-acceptance-closure.ts` rejects a `done` transition for
  a TFOS-ALIGN/remediation-program issue when a checklist item is unchecked or
  lacks an evidence pointer. The route returns HTTP 422 and lists the failed
  evaluations.

## Live state observed for this remediation

- `GET /api/health` at `127.0.0.1:3100` returned 200 on 2026-08-26. The live
  service reports commit `0923ab575cc6094e6a7757da43c8ac8d732f092c`; it is not
  the closure-guard worktree commit `6b838ec5924e19abd1b9af52199df4983db47026`.
  A live HTTP-422 close attempt must wait for the tracked deployment verification
  work in PAP-2926; no unevidenced issue was closed merely to probe the old
  server.
- PAP-2923 run `12f3f9be-3242-4936-a504-4f2ec785576d` is recorded with
  `invocationSource=assignment` and started at `2026-08-26T06:28:08.778Z`.
  This is fresh evidence that assignment starts a worker run without a manual
  heartbeat invocation.
- That run's execution workspace is `project_primary`, so it is explicitly
  **not** evidence of an isolated control-plane worktree. An isolated execution
  receipt still needs `strategy=git_worktree` plus a distinct `worktreePath`.
- The live registry reports the following agents in `error`: Kimi Code
  (`15ef21e0-252a-40d8-90e3-316ff5d8d04f`, last heartbeat
  `2026-08-19T01:58:28.791Z`), Google Antigravity Subscription
  (`7c565d23-4711-4381-a662-97dd9836f5af`, `2026-08-11T20:02:09.517Z`), and
  TF Risk Auditor (`ab646839-2540-455d-b608-bee0cbff5422`,
  `2026-08-25T15:50:04.907Z`). Each has a separate tracked remediation issue:
  PAP-2927, PAP-2928, and PAP-2929, respectively. None has been silently
  resumed.

## PAP-2924 refresh record (2026-08-26)

This refresh ran from the isolated Paperclip checkout
`codex/pap-2923-tfos-closure-guard` at `f039fe9d9823e08f4e5e4168d4e31d46021c655d`.
It is not the canonical Paperclip checkout, as confirmed by `git worktree
list --porcelain`.

| Evaluation | Current result | Receipt |
| --- | --- | --- |
| Assignment produces an assignment wake/run | Not live-verifiable | `127.0.0.1:3100` refused connections; the embedded-Postgres regression test `dispatches assigned todo work with no prior run as a normal assignment wake` was skipped because this host has no supported embedded Postgres runtime. |
| Execution uses an isolated worktree | Passed at code level | `pnpm --dir server exec vitest run src/__tests__/workspace-runtime.test.ts -t 'creates and reuses a git worktree for an issue-scoped branch'` — 1 passed, 60 skipped (2026-08-26T04:31:52Z). |
| A deliberate failure remains failed and does not complete the issue | Not live-verifiable | The embedded-Postgres regression test `does not block paused-tree work when immediate continuation recovery is suppressed by the hold` was skipped for the same unsupported-runtime reason; no failed `heartbeat_runs` record can be honestly attached while the control plane is down. |
| Non-council worker dispatchability or an idle reason | Not live-verifiable | The current company registry could not be read while the control plane was offline. The scheduler regression test `clears due monitors that cannot be dispatched and records a skip` was likewise skipped because embedded Postgres is unavailable. The wake payload additionally states that Claude Subscription Worker is absent from this local registry snapshot. |
| TFOS closure rejects incomplete/unevidenced acceptance | Passed at code level | `pnpm --dir server exec vitest run src/services/tfos-acceptance-closure.test.ts` — 3 passed (2026-08-26T04:32:10Z). |

The first, third, and fourth evaluations require a healthy Paperclip service
and current Postgres-backed registry. Do not substitute these code-level checks
for `heartbeat_runs` or registry receipts. The control-plane operator must
restore `http://127.0.0.1:3100`, then execute the two-minute operator check
below and attach the returned run IDs/agent states before PAP-2924 can close.

## Two-minute operator check

1. Open the assigned issue and its `executionRunId`; confirm the newest
   `heartbeat_runs` record has `invocationSource=assignment`, a non-noop task,
   and a terminal status.
2. Read the run's workspace metadata. For isolated execution it must report
   `strategy=git_worktree` and a `worktreePath` different from the canonical
   checkout; verify that path appears in `git worktree list`.
3. Inspect the issue description before closing: every TFOS acceptance item must
   be `[x]` and its immediately following evidence block must contain a run ID,
   CI URL, or command receipt. Attempting `PATCH /api/issues/:id` with
   `{"status":"done"}` while an item is incomplete must return HTTP 422.
4. Inspect the agents list for a recent heartbeat or a recorded dormancy reason.
   For `error` agents, require a linked remediation issue or a landed fix before
   calling the loop healthy.

## Limits and ownership

This document describes the current dispatch and closure paths; it does not
reactivate agents, restart services, or certify the scheduler. PAP-2923 remains
open for independent live verification of the five PAP-2585 evaluations and for
a non-author review of the eventual change.
