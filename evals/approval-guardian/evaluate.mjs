#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DECISIONS = ["AUTO_APPROVE", "AUTO_REJECT", "REVISE", "QUARANTINE", "HUMAN_ESCALATION"];
const DEFAULT_RUBRIC_VERSION = "approval-guardian-pilot-v1";
const RECORD_SCHEMA_VERSION = 1;
const EVALUATOR_VERSION = "approval-guardian-evaluator-v1";
const HIGH_IMPACT_EFFECTS = new Set([
  "financial_commitment",
  "legal_commitment",
  "policy_change",
  "public_publication",
  "security_boundary_change",
]);
const HARD_EXCLUSION_EFFECTS = new Set(["canonical_db_write", "destructive", "secret_rotation"]);
const SENSITIVE_CLASSES = new Set(["credentials", "secrets", "security", "financial", "legal"]);
const SECRET_PATTERNS = [
  { code: "private_key", pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i },
  { code: "api_key", pattern: /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[a-z0-9_\-.]{16,}/i },
  { code: "bearer_token", pattern: /\b(bearer|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[a-z0-9_\-.]{20,}/i },
  { code: "password", pattern: /\b(password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]{8,}/i },
];

function usage() {
  return [
    "Usage: node evals/approval-guardian/evaluate.mjs --input <packets.json> [--output <decisions.jsonl>] [--decision-log <decisions.jsonl>] [--metrics-output <metrics.json>]",
    "",
    "Input may be a single candidate packet, an array of packets, or { candidates: [...] }.",
    "The command is read-only except for optional output files.",
    "Live mutation modes are intentionally unsupported by this pilot.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { input: "", output: "", metricsOutput: "", pretty: true, dryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") args.input = argv[++index] ?? "";
    else if (arg === "--output") args.output = argv[++index] ?? "";
    else if (arg === "--decision-log") args.output = argv[++index] ?? "";
    else if (arg === "--metrics-output") args.metricsOutput = argv[++index] ?? "";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--live") args.dryRun = false;
    else if (arg === "--jsonl") args.pretty = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.candidates)) return value.candidates;
  if (value && typeof value === "object") return [value];
  throw new Error("Input must be a candidate packet, an array, or { candidates: [...] }");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function unique(values) {
  return [...new Set(values)];
}

function readSourceForHash(source, baseDir) {
  if (!source || typeof source !== "object") return null;
  if (typeof source.inlineText === "string") return source.inlineText;
  if (typeof source.uri !== "string" || !source.uri.startsWith("file://")) return null;
  const filePath = path.resolve(baseDir, source.uri.slice("file://".length));
  return fs.readFileSync(filePath);
}

function findSecretHits(candidate) {
  const text = stableJson(candidate);
  return SECRET_PATTERNS.filter((rule) => rule.pattern.test(text)).map((rule) => rule.code);
}

function hardExclusions(candidate, sourceState, secretHits, sideEffects, options) {
  const reasonCodes = [];
  const evidence = [];

  if (!options.dryRun) reasonCodes.push("live_mode_requested");
  if (candidate.dryRunOnly === false) reasonCodes.push("candidate_allows_live_mutation");
  if (candidate.mutatesCanonicalState === true) reasonCodes.push("mutates_canonical_state");
  for (const effect of sideEffects) {
    if (HARD_EXCLUSION_EFFECTS.has(effect)) reasonCodes.push(`hard_exclusion_${effect}`);
  }

  if (sourceState.expectedHash) {
    if (sourceState.sourceBytes === null) {
      reasonCodes.push("source_hash_unverifiable");
    } else if (sourceState.actualHash !== sourceState.expectedHash) {
      reasonCodes.push("source_hash_mismatch");
      evidence.push({ type: "source_hash", expected: sourceState.expectedHash, actual: sourceState.actualHash });
    } else {
      evidence.push({ type: "source_hash", expected: sourceState.expectedHash, actual: sourceState.actualHash });
    }
  } else {
    reasonCodes.push("missing_source_hash");
  }

  if (secretHits.length > 0) {
    reasonCodes.push(...secretHits.map((hit) => `secret_scan_${hit}`));
    evidence.push({ type: "secret_scan", hits: secretHits });
  }

  return { reasonCodes, evidence };
}

function normalizeValidatorResults(candidate) {
  const results = Array.isArray(candidate.validatorResults) ? candidate.validatorResults : [];
  return results.map((result) => ({
    name: String(result?.name ?? "unnamed_validator"),
    status: String(result?.status ?? "missing").toLowerCase(),
    score: typeof result?.score === "number" ? result.score : null,
    evidence: result?.evidence ?? null,
  }));
}

function candidateScore(candidate, validatorResults) {
  if (typeof candidate?.scores?.overall === "number") return candidate.scores.overall;
  const numericScores = validatorResults
    .map((result) => result.score)
    .filter((score) => typeof score === "number" && Number.isFinite(score));
  if (numericScores.length === 0) return 0;
  return numericScores.reduce((sum, score) => sum + score, 0) / numericScores.length;
}

function classifyCandidate(candidate, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const now = options.now ?? new Date().toISOString();
  const dryRun = options.dryRun ?? true;
  const validatorResults = normalizeValidatorResults(candidate);
  const reasonCodes = [];
  const evidence = [];
  const sideEffects = Array.isArray(candidate.sideEffects) ? candidate.sideEffects.map(String) : [];
  const sensitivity = String(candidate.sensitivity ?? "low").toLowerCase();
  const source = candidate.source && typeof candidate.source === "object" ? candidate.source : {};
  const expectedHash = typeof source.sha256 === "string" ? source.sha256.toLowerCase() : "";
  const sourceBytes = readSourceForHash(source, baseDir);
  const actualHash = sourceBytes === null ? null : sha256(sourceBytes);
  const secretHits = findSecretHits(candidate);
  const hard = hardExclusions(
    candidate,
    { expectedHash, actualHash, sourceBytes },
    secretHits,
    sideEffects,
    { dryRun },
  );
  reasonCodes.push(...hard.reasonCodes);
  evidence.push(...hard.evidence);

  const failedValidators = validatorResults.filter((result) => ["fail", "failed", "error"].includes(result.status));
  const warningValidators = validatorResults.filter((result) => ["warn", "warning", "missing"].includes(result.status));
  if (failedValidators.length > 0) reasonCodes.push("validator_failed");
  if (warningValidators.length > 0) reasonCodes.push("validator_warning");
  if (validatorResults.length === 0) reasonCodes.push("no_validator_results");

  const highImpactSideEffects = sideEffects.filter((effect) => HIGH_IMPACT_EFFECTS.has(effect));
  if (highImpactSideEffects.length > 0) {
    reasonCodes.push(...highImpactSideEffects.map((effect) => `high_impact_${effect}`));
  }
  if (SENSITIVE_CLASSES.has(sensitivity)) reasonCodes.push(`sensitive_${sensitivity}`);
  if (candidate.authorContextId && candidate.guardianContextId && candidate.authorContextId === candidate.guardianContextId) {
    reasonCodes.push("author_guardian_same_context");
  }

  const score = candidateScore(candidate, validatorResults);
  const confidence = typeof candidate.confidence === "number" ? candidate.confidence : score;
  let decision = "AUTO_APPROVE";
  let decisionStage = "guardian_score";

  if (
    hard.reasonCodes.some(
      (code) =>
        code === "live_mode_requested" ||
        code === "candidate_allows_live_mutation" ||
        code === "mutates_canonical_state" ||
        code === "source_hash_mismatch" ||
        code.startsWith("secret_scan_") ||
        code.startsWith("hard_exclusion_"),
    )
  ) {
    decision = "QUARANTINE";
    decisionStage = "hard_exclusion";
  } else if (
    reasonCodes.some(
      (code) =>
        code.startsWith("high_impact_") ||
        code.startsWith("sensitive_") ||
        code === "author_guardian_same_context",
    )
  ) {
    decision = "HUMAN_ESCALATION";
  } else if (failedValidators.length > 0 || score < 0.45 || confidence < 0.45) {
    decision = "AUTO_REJECT";
  } else if (
    warningValidators.length > 0 ||
    reasonCodes.includes("missing_source_hash") ||
    reasonCodes.includes("source_hash_unverifiable") ||
    reasonCodes.includes("no_validator_results") ||
    score < 0.82 ||
    confidence < 0.82
  ) {
    decision = "REVISE";
  }

  const inputPacketSha256 = sha256(stableJson(candidate));
  const rubricVersion = String(candidate.rubricVersion ?? DEFAULT_RUBRIC_VERSION);
  const candidateId = String(candidate.id ?? candidate.candidateId ?? inputPacketSha256.slice(0, 16));
  const decisionRecordId = sha256(
    stableJson({
      candidateId,
      decision,
      reasonCodes: unique(reasonCodes),
      rubricVersion,
      inputPacketSha256,
      evaluatorVersion: EVALUATOR_VERSION,
    }),
  );
  const record = {
    recordType: "approval_guardian_decision",
    schemaVersion: RECORD_SCHEMA_VERSION,
    decisionRecordId,
    candidateId,
    decision,
    decisionStage,
    rubricVersion,
    evaluatorVersion: EVALUATOR_VERSION,
    evaluatedAt: now,
    timestamp: now,
    inputPacketSha256,
    source: {
      uri: source.uri ?? null,
      sha256: expectedHash || null,
    },
    destination: candidate.destination ?? null,
    proposedAction: candidate.proposedAction ?? null,
    sensitivity,
    sideEffects,
    score: Number(score.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    validatorResults,
    reasonCodes: unique(reasonCodes),
    hardExclusionCodes: hard.reasonCodes.filter(
      (code) =>
        code === "live_mode_requested" ||
        code === "candidate_allows_live_mutation" ||
        code === "mutates_canonical_state" ||
        code === "source_hash_mismatch" ||
        code.startsWith("secret_scan_") ||
        code.startsWith("hard_exclusion_"),
    ),
    evidence,
    modelRuntime: {
      guardian: candidate.guardianRuntime ?? "approval-guardian-pilot",
      authorContextId: candidate.authorContextId ?? null,
      guardianContextId: candidate.guardianContextId ?? null,
    },
    replay: {
      inputPacketSha256,
      evaluatorVersion: EVALUATOR_VERSION,
      rubricVersion,
      dryRunOnly: true,
      canonicalWrites: false,
    },
    expectedDecision: candidate.expectedDecision ?? null,
    humanOverrideDecision: candidate.humanOverrideDecision ?? null,
  };
  return record;
}

function computeMetrics(records) {
  const total = records.length;
  const byDecision = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  const byReasonCode = {};
  let falseApprovals = 0;
  let falseRejections = 0;
  let overrides = 0;
  let hardExclusions = 0;
  for (const record of records) {
    byDecision[record.decision] = (byDecision[record.decision] ?? 0) + 1;
    if (Array.isArray(record.reasonCodes)) {
      for (const code of record.reasonCodes) byReasonCode[code] = (byReasonCode[code] ?? 0) + 1;
    }
    if (Array.isArray(record.hardExclusionCodes) && record.hardExclusionCodes.length > 0) hardExclusions += 1;
    if (record.expectedDecision && record.decision !== record.expectedDecision) {
      if (record.decision === "AUTO_APPROVE") falseApprovals += 1;
      if (record.decision === "AUTO_REJECT") falseRejections += 1;
    }
    if (record.humanOverrideDecision && record.humanOverrideDecision !== record.decision) overrides += 1;
  }
  const rate = (count) => (total === 0 ? 0 : Number((count / total).toFixed(4)));
  return {
    total,
    byDecision,
    byReasonCode,
    escalationRate: rate(byDecision.HUMAN_ESCALATION + byDecision.QUARANTINE),
    hardExclusionRate: rate(hardExclusions),
    falseApprovalRate: rate(falseApprovals),
    falseRejectionRate: rate(falseRejections),
    overrideRate: rate(overrides),
    hardExclusions,
    falseApprovals,
    falseRejections,
    overrides,
  };
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.input) throw new Error("--input is required");
  if (!args.dryRun) throw new Error("--live is not supported: approval-guardian pilot is read-only/dry-run only");
  const inputPath = path.resolve(args.input);
  const candidates = asArray(readJson(inputPath));
  const baseDir = path.dirname(inputPath);
  const records = candidates.map((candidate) => classifyCandidate(candidate, { baseDir, dryRun: args.dryRun }));
  const metrics = computeMetrics(records);
  const payload = {
    recordType: "approval_guardian_evaluation",
    schemaVersion: RECORD_SCHEMA_VERSION,
    evaluatorVersion: EVALUATOR_VERSION,
    dryRunOnly: true,
    canonicalWrites: false,
    rubricVersion: DEFAULT_RUBRIC_VERSION,
    records,
    metrics,
  };

  if (args.output) writeJsonl(path.resolve(args.output), records);
  if (args.metricsOutput) {
    const metricsPath = path.resolve(args.metricsOutput);
    fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
  }

  if (args.pretty) console.log(JSON.stringify(payload, null, 2));
  else console.log(records.map((record) => JSON.stringify(record)).join("\n"));
  return records.some((record) => record.decision === "QUARANTINE") ? 2 : 0;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  }
}

export { DECISIONS, classifyCandidate, computeMetrics, main };
