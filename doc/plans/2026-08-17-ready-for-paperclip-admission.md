# 2026-08-17 Ready for Paperclip admission

## Decision

Owner chose option B: keep Linear `Triage` as the human/ops inbox and introduce a dedicated admission state **`Ready for Paperclip`**.

## Admission invariant

An issue enters Paperclip execution intake only when both are true:

1. Linear state = `Ready for Paperclip`
2. Description contains a valid `tf-work-contract` (`tf-work/v1`) that passes validation

Anything else fails closed:

- Ordinary `Triage` items are ignored (not execution candidates)
- `Ready for Paperclip` without a valid contract is rejected with per-item id/reason evidence
- `Backlog` / `Todo` / `In Progress` are never admission candidates

## Migration posture

- Do not mass-move existing Triage backlog into the new state
- Do not manufacture contracts to drain the queue
- Preserve Phase 1 reject observability

## Implementation notes

- Constant: `ADMISSION_LINEAR_STATE_NAME = "Ready for Paperclip"`
- Config default + enabled validation: exactly that one candidate status name
- Hard fail-closed in `isCandidateLinearIssue` so config drift cannot reopen Triage admission
