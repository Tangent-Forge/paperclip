# Agent Approval Guardian Pilot

Read-only evaluator for immutable approval candidate packets.

```bash
pnpm evals:approval-guardian
node evals/approval-guardian/evaluate.mjs --input packet.json --output decisions.jsonl --metrics-output metrics.json
```

The command emits one decision record per packet:

- `AUTO_APPROVE`
- `AUTO_REJECT`
- `REVISE`
- `QUARANTINE`
- `HUMAN_ESCALATION`

The pilot does not write canonical databases or promotion targets. Optional output files contain decision records and aggregate metrics only.

Candidate packets should include immutable source pointers and hashes, validator results, sensitivity and side-effect classification, author and guardian context ids, scores, and optional `expectedDecision` / `humanOverrideDecision` fields for measuring false approvals, false rejections, and overrides.
