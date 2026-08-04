# Tangent Forge collaboration orchestration

Status: implementation runbook

This runbook defines the Paperclip-side loop for one item selected from
Linear Triage. It deliberately uses Paperclip issues, routines, assignments,
comments, and execution-policy review stages as the system of record. Slack
may announce state changes, but it must not create work, dispatch workers, or
decide completion.

## Boundary

The Linear connector is an external integration. It may read a Triage item and
call Paperclip's authenticated routine trigger, but it must not write directly
to worker queues. Paperclip owns the resulting execution issue and all later
coordination.

Do not put a Linear token, routine-trigger secret, or agent key in a routine
description, issue comment, or this document. The connector uses its configured
secret reference at request time.

## The loop

```text
Linear Triage item
  -> Paperclip webhook routine (idempotency key = linear:<issue-id>:<updated-at>)
  -> coordinator issue assigned to Chief of Staff / CTO
  -> role-separated child issues assigned to workers
  -> worker comments and work products on their child issue
  -> coordinator reconciliation comment on the parent issue
  -> in_review execution-policy stage assigned to reviewer
  -> reviewer decision closes or returns the coordinator issue
```

The coordinator is responsible for routing. Workers do not reassign sibling
work, and the reviewer must be a distinct agent or board user from the worker
whose output is being reviewed.

## Configure intake

Create or update one Paperclip routine for the coordinator with:

- `status: active`
- `concurrencyPolicy: coalesce_if_active`
- a `webhook` trigger using the configured signing mode
- an assignee that is the TF Chief of Staff or CTO, according to the current
  company routing policy

The connector posts the Linear item's stable identifier, URL, title,
description, state, and `updatedAt` to:

`POST /api/routine-triggers/public/:publicId/fire`

It supplies the trigger authentication headers and an `Idempotency-Key` of
`linear:<linear-issue-id>:<linear-updated-at>`. Replaying the same delivery
therefore returns the existing routine run/issue rather than starting another
coordinator run. A changed `updatedAt` deliberately creates a new triage pass.

The routine's coordinator prompt must require these actions:

1. Search Paperclip for the Linear identifier before creating work. If a live
   issue already represents the item, add a reconciliation comment there and
   stop.
2. Create at most the necessary child issues through
   `POST /api/issues/:parentId/children`, each with one role-specific assignee.
3. Include the Linear identifier and URL in the parent and child descriptions.
4. Have each worker attach output as a comment, document, or work product to
   its assigned child issue.
5. Reconcile the child outcomes into one parent comment, listing each child
   identifier, state, result, and blocker.
6. Move the parent to `in_review` with an execution policy whose first stage
   is a `review` participant that is not a completing worker.

## Reconciliation and closeout

Use parent/child links for work breakdown and `blockedByIssueIds` only when the
parent truly cannot continue until a child resolves. A parent link by itself is
not an execution dependency.

Before requesting review, the coordinator adds a parent comment in this form:

```markdown
## Collaboration reconciliation

- Linear: TAN-123 — https://linear.app/example/TAN-123
- PAP-101 (research): completed — findings attached
- PAP-102 (implementation): completed — work product attached
- PAP-103 (validation): completed — test result attached
- Decision requested: approve closeout
```

The parent then transitions to `in_review` with an execution policy equivalent
to:

```json
{
  "stages": [
    {
      "type": "review",
      "participants": [{ "type": "agent", "agentId": "REVIEWER_AGENT_ID" }]
    }
  ]
}
```

Paperclip creates the pending review state and wakes the reviewer. The reviewer
records its decision on the parent issue. An approval uses a review comment
with the structured approved marker; Paperclip atomically records the decision
and transitions the issue to `done`. A rejection must keep or return the issue
to executable work with the concrete correction recorded in the issue trail.

## Verification checklist

Use a non-production fixture item before activating any real connector:

1. Deliver the same Linear payload twice with the same idempotency key; verify
   that both responses reference one routine run and one coordinator issue.
2. Verify the coordinator has created role-separated child issues and that each
   has exactly one assignee.
3. Add worker output to each child and verify the parent reconciliation comment
   links the results and blockers.
4. Verify the parent cannot be closed by the coordinator while the review
   stage is pending.
5. Submit an approval from the configured reviewer and verify that the parent
   becomes `done` with a recorded review decision.

## Operating notes

- Existing routine dispatch already persists an idempotency key, a dispatch
  fingerprint, and the linked execution issue. Do not replace that with Slack
  deduplication.
- The connector is an external/plugin boundary; adding or rotating its
  credentials is a separately approved operation.
- If a triage item involves secrets, authentication, or production mutation,
  route a TF Risk Auditor review before that mutation.
