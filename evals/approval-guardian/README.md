# Agent Approval Guardian Pilot

Read-only evaluator for immutable approval candidate packets.

```bash
pnpm evals:approval-guardian
node evals/approval-guardian/evaluate.mjs --input packet.json --decision-log decisions.jsonl --metrics-output metrics.json
node evals/approval-guardian/evaluate.mjs --input packet.json --explain candidate-id
node evals/approval-guardian/evaluate.mjs --input packet.json --replay decisions.jsonl
```

The command emits one replayable decision record per packet:

- `AUTO_APPROVE`
- `AUTO_REJECT`
- `REVISE`
- `QUARANTINE`
- `HUMAN_ESCALATION`

The pilot is dry-run/read-only only. `--live` is rejected, and optional output files contain decision records and aggregate metrics only. It does not write canonical databases or promotion targets.

`--decision-log` / `--output` writes an append-only JSONL ledger. The writer uses stable `decisionRecordId` idempotency and a local lock file so repeated or concurrent evaluator runs do not duplicate records or truncate previous decisions.

Hard exclusions are evaluated before score-based Guardian decisions. Hash mismatches, detected secrets, canonical mutation requests, and explicitly destructive/write side effects are quarantined before confidence or validator scores are considered.

The deterministic policy engine combines hard gates, validator status, score, confidence, high-impact side effects, sensitivity, same-context review, and model disagreement into one of the five decisions. Candidate packets may provide explicit `modelDisagreement` or structured `modelVotes`; material disagreement escalates to human review.

Each JSONL decision record includes:

- stable `decisionRecordId`
- `inputPacketSha256`
- `decisionStage`
- `reasonCodes` and `hardExclusionCodes`
- separated author and Guardian context ids under `modelRuntime`
- `replay` metadata with evaluator/rubric versions and read-only flags

`--explain` emits a compact explanation for one candidate or decision record id. `--replay` recomputes decisions from pinned input packets against an existing ledger and fails when decision ids, decisions, reason codes, or input packet hashes diverge.

Metrics include decision counts, escalation rate, hard-exclusion rate, false approval rate, false rejection rate, override rate, and counts by reason code.

The default pilot fixture covers all five Guardian decisions and checks metric thresholds:

- decision coverage must include all five decisions
- escalation rate must be at least `0.2`
- hard-exclusion rate must be at least `0.2`
- false approval and false rejection rates must stay at `0`
- override rate must stay at or below `0.25`

Expected quarantines are valid pilot outcomes. The CLI exits non-zero when metric thresholds fail.

Candidate packets should include immutable source pointers and hashes, validator results, sensitivity and side-effect classification, author and guardian context ids, scores, and optional `expectedDecision` / `humanOverrideDecision` fields for measuring false approvals, false rejections, and overrides.
