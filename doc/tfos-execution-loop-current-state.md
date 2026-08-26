# TFOS execution loop: current state

Verified-state date: 2026-08-25

This document records the live state that can be proved from Paperclip rather
than the intended design. It is deliberately conservative: a component is not
described as autonomous unless a current run receipt proves it.

## Actual dispatch path

1. A board user or an authorized agent assigns an issue to an agent through
   `PATCH /api/issues/:id` or checks it out with `POST /api/issues/:id/checkout`.
2. The issue route validates assignment authorization and the issue service
   records the assignee and execution lock.
3. `queueIssueAssignmentWakeup` creates an assignment wakeup request.
4. The heartbeat scheduler claims the wakeup, starts a `heartbeat_runs` record,
   and invokes the agent's configured adapter.
5. The adapter reports its outcome; the issue is only complete when its route
   permits a transition to `done`.

## Current verified state

- The source code provides assignment-triggered wakeups and heartbeat-run
  records, but this run could not contact the local control-plane API at
  `127.0.0.1:3100`; no fresh live run receipt is claimed here.
- This issue's injected execution workspace strategy is `project_primary`.
  It is not evidence of the required isolated-worktree execution.
- The closure path now rejects `done` for TFOS-ALIGN issues unless every
  checklist item is checked and carries a markdown evidence link. The guard is
  evaluated on `PATCH /api/issues/:id`, the authoritative status-transition
  route.

## Two-minute health check

1. `GET /api/issues/<issue-id>/heartbeat-context` — confirm the issue is
   assigned and inspect execution context.
2. `GET /api/agents/<agent-id>/runs` (or the board run view) — find a recent
   `assignment`-triggered `heartbeat_runs` record and its terminal status.
3. Open that run's context snapshot and execution workspace record. Confirm the
   workspace is a dedicated worktree, not a canonical/shared checkout.
4. If any of these records are absent, treat the loop as dormant or
   unverified; do not close the evidence issue.

## Known evidence gap

Fresh, live proof for PAP-2585's five evaluations remains required. In
particular, this document does not assert that dormant/error agents are
dispatchable, that a failure was handled correctly, or that an isolated
worktree was used. Those claims need linked, current receipts before closure.
