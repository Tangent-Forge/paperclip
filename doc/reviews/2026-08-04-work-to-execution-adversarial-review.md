# Adversarial Review — Work-to-Execution Contract

Reviewer: independent adversarial pass

Branch: `feat/work-to-execution-linear-v1`

Reviewed against: `doc/plans/2026-08-04-work-to-execution-contract.md`

Date: 2026-08-04

## Summary

- Overall verdict: PASS with one verification-environment warning
- Blocking issues: 0
- Warnings: 1

The first review pass found two correctness gaps: the reconciler accepted current Triage without a contract, and enabled sync did not require a triage agent or Triage-only configuration. Both were corrected before this report. The final implementation fails closed at admission, preserves an explicit stable admission receipt, requires evidence-ranked completion, and prevents Backlog/Todo execution even under candidate-status configuration drift.

## 1. Bugs

Verdict: PASS

- `packages/shared/src/work-contract.ts` validates the mandatory contract structure and rejects a mismatched stable work id.
- Admission is limited to current Linear Triage plus a valid contract.
- The reconciler requires a matching current contract or a preserved admission receipt; terminal tracker states without an evaluable contract become `state_conflict`.
- Linear import evaluates admission before reserving a link, creating a Paperclip issue, commenting in Linear, moving Linear state, or requesting wakeup.
- Duplicate delivery remains protected by the existing origin/link reservation and idempotent triage wake key.
- Enabled connector validation requires a triage agent and exactly one candidate state, Triage.

## 2. Security

Verdict: PASS

- No credential values, live secret identifiers, bearer tokens, or provider keys were added to source or documentation.
- Linear credential fields are explicitly annotated as `secret-ref`; ordinary UUID fields such as `triageAgentId` are no longer misclassified as credentials.
- The new partial-config route is instance-admin-only.
- It validates the effective merged config before persistence.
- It rejects any secret reference introduced by the patch while preserving pre-existing references.
- Activity metadata records only sorted patch key names, not values.
- No direct database bypass, secret read, provider crawl, outreach, Notion write, deployment, or live mutation is part of this implementation.

## 3. Spec drift

Verdict: PASS

- Backlog and Todo are portfolio states only and cannot pass the hard runtime candidate guard.
- Triage is explicit admission and requires a valid `tf-work/v1` contract.
- TF Chief of Staff is required as the configured triage agent before enabled config validates.
- The shared contract, completion evaluator, delivery-state ranking, admission receipt, and reconciler are exported through the shared package and plugin SDK.
- The reconciliation endpoint is read/evaluate-only and performs no provider or tracker mutation.
- TAN-819–823 evidence is preserved; the global specification records their truthful delivery states rather than claiming implementation, publication, deployment, or live execution that did not occur.

## 4. Test coverage

Verdict: PASS

Verified locally:

- Linear plugin suite: 20 passing tests.
- Shared package TypeScript check and build: passing.
- Plugin SDK TypeScript check and build: passing.
- Linear plugin TypeScript check and build: passing.
- Server plugin authorization and OpenAPI suites: 41 passing tests.
- Diff whitespace/error check: passing.
- Secret-pattern scan of changed source and documentation: no findings.

Coverage includes:

- positive contract-valid Triage admission;
- negative Backlog and Todo canaries under deliberate config drift;
- negative Triage-without-contract canary;
- exact one-issue/one-wakeup idempotency;
- required triage-agent/config validation;
- completion denial for insufficient delivery and receipts;
- terminal tracker conflict without a contract;
- claimed delivery exceeding evidenced delivery;
- non-admin partial-config denial;
- safe preservation of an existing credential reference;
- rejection of a newly introduced credential reference;
- OpenAPI registration.

## 5. Documentation

Verdict: PASS

The company-wide plan documents the problem, global impact, authority boundaries, PAMCRAFT review frame, work contract, triage role, delivery states, evaluator, reconciler, canaries, rollout, rollback, TAN-819–823 reconciliation, and adoption acceptance criteria.

## Warning

The final full server-package TypeScript check could not be reproduced after the previous exact dependency worktree disappeared during the session. A later available dependency snapshot reports unrelated cross-package baseline mismatches. The affected server route did pass its targeted authorization tests and had passed server TypeScript checking earlier in this implementation sequence before that dependency snapshot disappeared. This is a verification-environment warning, not a known source defect, and should be rerun in the exact deployment/CI dependency environment before merge.

## Rollout gate

This PASS supports the local reviewable commit only. It does not authorize push, merge, deployment, live config mutation, or live canaries. Those remain separate owner decisions.
