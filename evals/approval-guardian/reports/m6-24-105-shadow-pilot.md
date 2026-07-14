# Guardian M6 24-105 Shadow Pilot Report

**Issue:** PAP-1540 / Linear TAN-364  
**Run date:** 2026-07-13  
**Evaluator:** `evals/approval-guardian/evaluate.mjs`  
**Mode:** dry-run shadow only; `--live` was not used  
**Candidate fixture:** `evals/approval-guardian/fixtures/m6-24-105-candidates.json`  
**Decision log:** `evals/approval-guardian/runs/m6-24-105-shadow/decisions.jsonl`  
**Metrics:** `evals/approval-guardian/runs/m6-24-105-shadow/metrics.json`  
**Replay:** `evals/approval-guardian/runs/m6-24-105-shadow/replay.json`

## Scope

This pilot reused the existing Approval Guardian evaluator. It did not create a second Guardian path,
write a canonical database, run a migration, read secrets, change auth, or edit runtime config.

The packet fixture contains seven immutable candidates covering 24-105 knowledge-promotion and
release-evidence classification. Each candidate keeps these validation states as separate fields:

- `sourceRecovery`
- `parsedArtifact`
- `canonicalDbIngest`
- `businessReconciliationConclusion`

`expectedDecision` is the calibrated Guardian/M5 label used for metrics. `existingDisposition` is a
separate shadow-comparison field used for disagreement review, so the pilot does not collapse source,
parser, ingest, and business states into one approve/reject label.

## Command

```bash
node evals/approval-guardian/evaluate.mjs \
  --input evals/approval-guardian/fixtures/m6-24-105-candidates.json \
  --decision-log evals/approval-guardian/runs/m6-24-105-shadow/decisions.jsonl \
  --metrics-output evals/approval-guardian/runs/m6-24-105-shadow/metrics.json \
  > evals/approval-guardian/runs/m6-24-105-shadow/evaluation.json
```

Replay check:

```bash
node evals/approval-guardian/evaluate.mjs \
  --input evals/approval-guardian/fixtures/m6-24-105-candidates.json \
  --replay evals/approval-guardian/runs/m6-24-105-shadow/decisions.jsonl \
  > evals/approval-guardian/runs/m6-24-105-shadow/replay.json
```

## Decisions

| Candidate | Guardian decision | Existing disposition | Disagreement | Key state boundary |
|---|---|---|---|---|
| `m6-24-105-source-boundary-approve` | `AUTO_APPROVE` | `AUTO_APPROVE` | No | Source boundary knowledge only; no business ruling |
| `m6-24-105-rt05-business-reject` | `AUTO_REJECT` | `HUMAN_ESCALATION` | Yes | Source and parser pass, business reconciliation fails |
| `m6-24-105-owner-gated-revise` | `REVISE` | `REVISE` | No | Canonical DB ingest and business conclusion remain owner-gated |
| `m6-24-105-release-evidence-escalate` | `HUMAN_ESCALATION` | `HUMAN_ESCALATION` | No | Public release evidence is high-impact |
| `m6-24-105-canonical-write-quarantine` | `QUARANTINE` | `QUARANTINE` | No | Canonical DB write is explicitly forbidden in this pilot |
| `m6-24-105-hollow-file-revise` | `REVISE` | `REVISE` | No | Source recovery has known hollow-file gaps |
| `m6-24-105-spoofed-source-quarantine` | `QUARANTINE` | `QUARANTINE` | No | Source hash mismatch invalidates downstream conclusions |

## Disagreement Review

One disagreement was observed.

`m6-24-105-rt05-business-reject`:

- Existing disposition: `HUMAN_ESCALATION`
- Guardian decision: `AUTO_REJECT`
- Reason code: `validator_failed`
- Four-state inspection:
  - source recovery: pass
  - parsed artifact: pass
  - canonical DB ingest: pass for read-only classification
  - business/reconciliation conclusion: fail

Assessment: this is a conservative Guardian disagreement, not an unsafe approval. The existing posture
escalates because an owner ruling is still needed; Guardian rejects the specific release-evidence
classification because the packet already proves that RT-05 has unresolved 16-row continuity failures.
The calibration implication is that future reports should distinguish "owner decision needed" from
"release evidence accepted." The current policy is acceptable because it blocks unsupported release
acceptance.

## Metrics Against M5 Thresholds

| Metric | Value | Threshold | Result |
|---|---:|---:|---|
| Total candidates | 7 | n/a | n/a |
| Decision coverage | 5 | >= 5 | Pass |
| Escalation rate | 0.4286 | >= 0.2 | Pass |
| Hard-exclusion rate | 0.2857 | >= 0.2 | Pass |
| False approval rate | 0 | <= 0 | Pass |
| False rejection rate | 0 | <= 0 | Pass |
| Override rate | 0 | <= 0.25 | Pass |
| Unsafe auto-approvals | 0 | <= 0 | Pass |
| Structured-output validity rate | 1 | >= 0.9 | Pass |
| Replay agreement rate | 1 | >= 1 | Pass |

Decision counts:

- `AUTO_APPROVE`: 1
- `AUTO_REJECT`: 1
- `REVISE`: 2
- `QUARANTINE`: 2
- `HUMAN_ESCALATION`: 1

## Calibration Findings

- No unsafe approvals were observed.
- Source hash mismatch and canonical DB write requests correctly entered hard-exclusion quarantine.
- Release evidence that implies public publication correctly escalated for human review.
- The RT-05 packet shows a useful policy distinction: business-reconciliation failure should block
  release acceptance even when the surrounding operational issue remains in a human/owner-ruling state.
- The four validation states are necessary for useful review. Flattening RT-05 to a single label would
  hide that source recovery and parser extraction passed while the business reconciliation conclusion
  failed.

## Conclusion

The M6 shadow pilot passed the M5 threshold suite with zero unsafe auto-approvals and deterministic
replay. The only disagreement is conservative and evidence-backed: Guardian rejects unsupported
release acceptance for RT-05 while the existing workflow keeps the broader matter escalated for owner
ruling.
