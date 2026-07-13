import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendDecisionLedger, classifyCandidate, computeMetrics, explainDecision, main, replayDecisions } from "./evaluate.mjs";

function writeSource(tmp, body = "source material") {
  const sourcePath = path.join(tmp, "source.txt");
  fs.writeFileSync(sourcePath, body);
  return sourcePath;
}

function validCandidate(id = "ok") {
  return {
    id,
    source: {
      inlineText: "source",
      sha256: "41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d",
    },
    sensitivity: "low",
    sideEffects: ["read_only_decision_record"],
    confidence: 0.91,
    authorContextId: "author",
    guardianContextId: "guardian",
    validatorResults: [{ name: "all", status: "pass", score: 0.92 }],
  };
}

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
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

test("escalates material model disagreement through the policy engine", () => {
  const record = classifyCandidate({
    ...validCandidate("disagreement"),
    modelVotes: [
      { model: "author", decision: "AUTO_APPROVE" },
      { model: "guardian-small", decision: "REVISE" },
      { model: "guardian-large", decision: "AUTO_REJECT" },
    ],
  });
  assert.equal(record.decision, "HUMAN_ESCALATION");
  assert.equal(record.modelDisagreement, 0.6667);
  assert.ok(record.reasonCodes.includes("model_disagreement"));
});

test("appends decision ledger records without truncating or duplicating stable decisions", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-guardian-ledger-"));
  const ledgerPath = path.join(tmp, "decisions.jsonl");
  const first = classifyCandidate(validCandidate("ledger-one"));
  const second = classifyCandidate(validCandidate("ledger-two"));

  assert.deepEqual(appendDecisionLedger(ledgerPath, [first]), { appended: 1, skipped: 0, total: 1 });
  assert.deepEqual(appendDecisionLedger(ledgerPath, [first, second]), { appended: 1, skipped: 1, total: 2 });

  const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).candidateId, "ledger-one");
  assert.equal(JSON.parse(lines[1]).candidateId, "ledger-two");
});

test("serializes concurrent ledger appends and preserves idempotency", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-guardian-concurrent-"));
  const ledgerPath = path.join(tmp, "decisions.jsonl");
  const inputPath = path.join(process.cwd(), "evals/approval-guardian/fixtures/pilot-candidates.json");

  const runs = await Promise.all(
    Array.from({ length: 5 }, () =>
      runNode(["evals/approval-guardian/evaluate.mjs", "--input", inputPath, "--decision-log", ledgerPath], process.cwd()),
    ),
  );

  assert.deepEqual(
    runs.map((run) => run.code),
    [0, 0, 0, 0, 0],
    runs.map((run) => run.stderr).join("\n"),
  );
  const records = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 5);
  assert.deepEqual(
    records.map((record) => record.candidateId).sort(),
    ["pilot-auto-approve", "pilot-auto-reject", "pilot-human-escalation", "pilot-quarantine-hash-mismatch", "pilot-revise"],
  );
});

test("explains and replays pinned decision records", () => {
  const candidate = validCandidate("pinned");
  const record = classifyCandidate(candidate);
  const explanation = explainDecision(record);
  assert.equal(explanation.recordType, "approval_guardian_explanation");
  assert.match(explanation.summary, /AUTO_APPROVE/);
  assert.equal(explanation.replay.inputPacketSha256, record.inputPacketSha256);

  const replay = replayDecisions([record], [candidate]);
  assert.equal(replay.recordType, "approval_guardian_replay");
  assert.equal(replay.passed, 1);
  assert.equal(replay.failed, 0);

  const tampered = replayDecisions([{ ...record, decisionRecordId: "0".repeat(64) }], [candidate]);
  assert.equal(tampered.passed, 0);
  assert.equal(tampered.failed, 1);
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
