# TFOS execution loop: current state

Last checked: 2026-08-25

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

- PAP-2923's bootstrap metadata identifies run
  `87f16c40-716a-4e53-a76f-9928dbca310b` as an `assignment` invocation and
  identifies PAP-2585 as returned to `in_review`. These are candidate evidence
  pointers, pending independent readback.
- This run is executing in the dedicated branch checkout
  `codex/pap-2923-tfos-closure-guard`, but its injected workspace strategy is
  `project_primary`. Therefore this run is **not** evidence that the control
  plane provisioned an isolated execution worktree.
- The local control-plane endpoint at `127.0.0.1:3100` was unavailable during
  this check. The current agent scheduler state, agent error records, a live
  failing-run result, and a live HTTP-422 closure attempt must be read from the
  control plane once it is reachable; none are inferred from this document.

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
