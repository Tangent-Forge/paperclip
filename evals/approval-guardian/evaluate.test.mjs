import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyCandidate, computeMetrics, main } from "./evaluate.mjs";

function writeSource(tmp, body = "source material") {
  const sourcePath = path.join(tmp, "source.txt");
  fs.writeFileSync(sourcePath, body);
  return sourcePath;
}

test("auto-approves low-risk validated packets", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-guardian-"));
  const sourcePath = writeSource(tmp);
  const record = classifyCandidate(
    {
      id: "ok",
      source: {
        uri: `file://${path.basename(sourcePath)}`,
        sha256: "eaca25944e8977dc7c136244de94456c8ebd9fdd64678b8f75fc51688fe30c36",
      },
      sensitivity: "low",
      sideEffects: ["read_only_decision_record"],
      confidence: 0.91,
      authorContextId: "author",
      guardianContextId: "guardian",
      validatorResults: [{ name: "all", status: "pass", score: 0.92 }],
    },
    { baseDir: tmp, now: "2026-07-12T00:00:00.000Z" },
  );
  assert.equal(record.decision, "AUTO_APPROVE");
  assert.equal(record.decisionStage, "guardian_score");
  assert.equal(record.recordType, "approval_guardian_decision");
  assert.equal(record.replay.canonicalWrites, false);
  assert.match(record.decisionRecordId, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.reasonCodes, []);
});

test("quarantines hash mismatches before approval", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-guardian-"));
  const sourcePath = writeSource(tmp, "tampered source");
  const record = classifyCandidate(
    {
      id: "hash-mismatch",
      source: { uri: `file://${path.basename(sourcePath)}`, sha256: "0".repeat(64) },
      sensitivity: "low",
      sideEffects: ["read_only_decision_record"],
      confidence: 0.95,
      validatorResults: [{ name: "all", status: "pass", score: 0.95 }],
    },
    { baseDir: tmp },
  );
  assert.equal(record.decision, "QUARANTINE");
  assert.equal(record.decisionStage, "hard_exclusion");
  assert.ok(record.reasonCodes.includes("source_hash_mismatch"));
  assert.ok(record.hardExclusionCodes.includes("source_hash_mismatch"));
});

test("quarantines live or canonical mutation candidates before scoring", () => {
  const record = classifyCandidate({
    id: "canonical-write",
    source: { inlineText: "source", sha256: "41cf679b6b0d6e0d6ca10e82d62d577a4efb361ee90ad54967c6570207aa1ff0" },
    sensitivity: "low",
    sideEffects: ["canonical_db_write"],
    mutatesCanonicalState: true,
    confidence: 0.99,
    validatorResults: [{ name: "all", status: "pass", score: 0.99 }],
  });
  assert.equal(record.decision, "QUARANTINE");
  assert.equal(record.decisionStage, "hard_exclusion");
  assert.ok(record.hardExclusionCodes.includes("hard_exclusion_canonical_db_write"));
  assert.ok(record.hardExclusionCodes.includes("mutates_canonical_state"));
});

test("escalates high-impact side effects and same-context review", () => {
  const record = classifyCandidate({
    id: "public-write",
    source: { inlineText: "source", sha256: "41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d" },
    sensitivity: "low",
    sideEffects: ["public_publication"],
    confidence: 0.95,
    authorContextId: "same",
    guardianContextId: "same",
    validatorResults: [{ name: "all", status: "pass", score: 0.95 }],
  });
  assert.equal(record.decision, "HUMAN_ESCALATION");
  assert.ok(record.reasonCodes.includes("high_impact_public_publication"));
  assert.ok(record.reasonCodes.includes("author_guardian_same_context"));
});

test("reports escalation, false decision, and override metrics", () => {
  const metrics = computeMetrics([
    { decision: "AUTO_APPROVE", expectedDecision: "AUTO_REJECT", humanOverrideDecision: null, reasonCodes: [] },
    { decision: "AUTO_REJECT", expectedDecision: "AUTO_APPROVE", humanOverrideDecision: null, reasonCodes: [] },
    { decision: "HUMAN_ESCALATION", expectedDecision: "HUMAN_ESCALATION", humanOverrideDecision: "AUTO_APPROVE", reasonCodes: [] },
    {
      decision: "QUARANTINE",
      expectedDecision: "QUARANTINE",
      humanOverrideDecision: null,
      reasonCodes: ["source_hash_mismatch"],
      hardExclusionCodes: ["source_hash_mismatch"],
    },
  ]);
  assert.equal(metrics.escalationRate, 0.5);
  assert.equal(metrics.hardExclusionRate, 0.25);
  assert.equal(metrics.falseApprovalRate, 0.25);
  assert.equal(metrics.falseRejectionRate, 0.25);
  assert.equal(metrics.overrideRate, 0.25);
  assert.equal(metrics.byReasonCode.source_hash_mismatch, 1);
  assert.equal(metrics.decisionCoverage, 4);
  assert.deepEqual(metrics.missingDecisions, ["REVISE"]);
  assert.equal(metrics.thresholdResults.passed, false);
});

test("passes metric thresholds for representative pilot coverage", () => {
  const metrics = computeMetrics([
    { decision: "AUTO_APPROVE", expectedDecision: "AUTO_APPROVE", humanOverrideDecision: null, reasonCodes: [] },
    { decision: "AUTO_REJECT", expectedDecision: "AUTO_REJECT", humanOverrideDecision: null, reasonCodes: [] },
    { decision: "REVISE", expectedDecision: "REVISE", humanOverrideDecision: "AUTO_APPROVE", reasonCodes: ["validator_warning"] },
    { decision: "QUARANTINE", expectedDecision: "QUARANTINE", humanOverrideDecision: null, reasonCodes: ["source_hash_mismatch"], hardExclusionCodes: ["source_hash_mismatch"] },
    { decision: "HUMAN_ESCALATION", expectedDecision: "HUMAN_ESCALATION", humanOverrideDecision: null, reasonCodes: ["high_impact_public_publication"] },
  ]);
  assert.equal(metrics.decisionCoverage, 5);
  assert.equal(metrics.escalationRate, 0.4);
  assert.equal(metrics.hardExclusionRate, 0.2);
  assert.equal(metrics.falseApprovalRate, 0);
  assert.equal(metrics.falseRejectionRate, 0);
  assert.equal(metrics.overrideRate, 0.2);
  assert.equal(metrics.thresholdResults.passed, true);
});

test("refuses live mode because the pilot is read-only", () => {
  assert.throws(() => main(["--input", "unused.json", "--live"]), /read-only\/dry-run only/);
});
