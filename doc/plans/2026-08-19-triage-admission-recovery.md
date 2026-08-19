# 2026-08-19 Triage admission recovery

## Decision

Restore Linear `Triage` as the sole explicit Paperclip execution-admission state.
`Backlog`, `Todo`, `Ready for Paperclip`, and every other state remain
non-admissible.

## Admission invariant

An issue enters Paperclip execution intake only when all conditions pass:

1. Linear state is exactly `Triage` (case-insensitive comparison).
2. The description contains a valid `tf-work-contract` (`tf-work/v1`).
3. The contract `workId` matches the stable Linear issue identity.
4. Linear Sync is enabled only after live positive, negative, and idempotency
   canaries pass against the deployed revision.

State membership without a valid contract is rejected with per-item evidence.
Configuration cannot widen admission to Backlog, Todo, Ready for Paperclip, or
any other state.

## Runtime recovery order

1. Keep stored intake configuration disabled.
2. Deploy the exact reviewed current-base revision under a current route gate.
3. Verify plugin lifecycle `ready` and configuration readback.
4. Prove Backlog and Todo are ignored.
5. Prove one contract-valid Triage issue imports exactly once, routes to TF
   Chief of Staff, and produces one idempotent wakeup.
6. Prove a repeated sync creates no duplicate origin or wakeup.
7. Re-enable scheduled intake only after every receipt is durable.

## Preserved boundaries

- No secret value resolution or emission.
- No deletion or rewriting of historical issues or canary receipts.
- No provider crawling, contact enrichment, outreach, or paid capacity.
- PR #89 remains the historical record of the superseded admission decision.
