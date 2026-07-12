import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyCandidate, computeMetrics } from "./evaluate.mjs";

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
  assert.ok(record.reasonCodes.includes("source_hash_mismatch"));
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
    { decision: "AUTO_APPROVE", expectedDecision: "AUTO_REJECT", humanOverrideDecision: null },
    { decision: "AUTO_REJECT", expectedDecision: "AUTO_APPROVE", humanOverrideDecision: null },
    { decision: "HUMAN_ESCALATION", expectedDecision: "HUMAN_ESCALATION", humanOverrideDecision: "AUTO_APPROVE" },
    { decision: "QUARANTINE", expectedDecision: "QUARANTINE", humanOverrideDecision: null },
  ]);
  assert.equal(metrics.escalationRate, 0.5);
  assert.equal(metrics.falseApprovalRate, 0.25);
  assert.equal(metrics.falseRejectionRate, 0.25);
  assert.equal(metrics.overrideRate, 0.25);
});
