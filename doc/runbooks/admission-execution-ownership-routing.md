# Admission → execution ownership routing

## Problem class (observed Gate 2D / ZH1 / ZH2)

1. **CTO intake lock** — Linear Sync import assigned `triageAgentId` and immediately `requestWakeup`s that agent. When the run starts, lazy locking stamps `issues.executionRunId`, so the intended worker cannot checkout until the intake run is cancelled.
2. **Unbound on-demand wake** — `POST /api/agents/:id/wakeup` and legacy `/heartbeat/invoke` allowed empty payloads. Runs with `issueId=null` could still attempt issue checkout.
3. **Contradictory wake bindings** — callers could supply disagreeing `issueId`/`taskId` across top-level, payload, and contextSnapshot fields.
4. **Stale checkout self-heal** — issue-row `checkoutRunId` may point at a terminal run; recovery must still run inside `svc.checkout` after the *caller run* passes scope checks.

## Target sequence (after this fix)

```
Linear admit (manual or poll)
  → Paperclip issue created as backlog
  → optional triageAgentId recorded as intake assignee (no execution wake by default)
  → board/harness assigns execution owner + status todo
  → issue-bound wake: POST /agents/:id/wakeup { issueId | payload.issueId }
  → worker checkout (run context issueId must match)
  → execution + receipt
```

## Config

Linear Sync instance config:

| Field | Default | Meaning |
| --- | --- | --- |
| `triageAgentId` | null | Optional intake/routing assignee metadata |
| `wakeTriageOnImport` | **false** | Opt-in only: set todo + wake triage once on import (old behavior) |

## API

- Wake body may include top-level `issueId` (UUID). It is merged into `payload` and `contextSnapshot` when consistent.
- Conflicting non-empty identifiers across top-level `issueId`, `payload.issueId`, `payload.taskId`, `contextSnapshot.issueId`, and `contextSnapshot.taskId` → **400** `contradictory_wake_issue_binding` (fail closed before run creation).
- Matching duplicated identifiers are accepted.
- Agent checkout with a **non-timer** run that has no bound issueId → **409** `unbound_on_demand_checkout_forbidden`.
  - **Timer is the only invocation source allowed to checkout unbound** (inbox pick-work).
  - Assignment helpers already supply issue binding; unbound assignment checkout is not a supported path.
- Run bound to issue A cannot checkout issue B → **409** `run_issue_scope_mismatch`.
- Scope gate inspects the **caller's current run** only. Rejected scope checks do not reopen workspaces or clear locks. Terminal stale `issues.checkoutRunId` is still cleared by `clearCheckoutRunIfTerminal` inside `svc.checkout` after the caller run is in-scope.
- Legacy empty `/heartbeat/invoke` body omits `payload` (does not send `payload: null`).

## Operator notes

- Keep periodic triage/dispatch paused until separately authorized.
- Prefer issue-bound wakes: `{ "source": "on_demand", "issueId": "<uuid>", "forceFreshSession": true }`.
- Do not re-enable `wakeTriageOnImport` unless intentional intake execution is desired.
