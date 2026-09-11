import { createHash } from "node:crypto";
import type {
  IngestOperationalReceipt,
  OperationalReceiptStatus,
  OperationalStatus,
  OperationalStatusCardConfig,
} from "@paperclipai/shared";

export type OperationalReceiptEvidence = {
  id: string;
  sourceKey: string;
  subjectKey: string;
  status: OperationalReceiptStatus;
  summary: string;
  observedAt: Date;
  freshUntil: Date;
  provenance: IngestOperationalReceipt["provenance"];
  observation: IngestOperationalReceipt["observation"];
};

export type OperationalStatusEvaluation = {
  state: OperationalStatus;
  reason: string;
  fingerprint: string;
  receipts: OperationalReceiptEvidence[];
  missingEvidence: Array<{ sourceKey: string; subjectKey: string; label: string }>;
  staleEvidence: OperationalReceiptEvidence[];
  observedAt: Date | null;
  freshUntil: Date | null;
};

export type OperationalTransition = {
  changed: boolean;
  failureStreak: number;
  recoveryStreak: number;
  summaryRequired: boolean;
  openException: boolean;
  resolveException: boolean;
};

export function stableOperationalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableOperationalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableOperationalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deriveOperationalReceiptStatus(
  observation: IngestOperationalReceipt["observation"],
): OperationalReceiptStatus {
  if (observation.kind === "check") return observation.result;

  const activeState = observation.activeState.toLowerCase();
  const result = observation.result.toLowerCase();
  if (activeState === "failed" || !["success", "done"].includes(result)) return "failed";
  if (activeState === "activating" || activeState === "deactivating" || activeState === "reloading") {
    return "degraded";
  }
  if (activeState === "active") return "passed";
  // A successful systemd oneshot normally sits inactive between executions.
  // Treating that expected resting state as failed would manufacture incidents.
  if (observation.unitType === "oneshot" && activeState === "inactive") return "passed";
  return "failed";
}

function evidenceKey(sourceKey: string, subjectKey: string) {
  return `${sourceKey}\u0000${subjectKey}`;
}

export function evaluateOperationalStatus(input: {
  config: OperationalStatusCardConfig;
  receipts: OperationalReceiptEvidence[];
  now: Date;
}): OperationalStatusEvaluation {
  const newest = new Map<string, OperationalReceiptEvidence>();
  for (const receipt of input.receipts) {
    const key = evidenceKey(receipt.sourceKey, receipt.subjectKey);
    const current = newest.get(key);
    if (!current || current.observedAt < receipt.observedAt) newest.set(key, receipt);
  }

  const missingEvidence: OperationalStatusEvaluation["missingEvidence"] = [];
  const staleEvidence: OperationalReceiptEvidence[] = [];
  const selected: OperationalReceiptEvidence[] = [];
  for (const requirement of input.config.requiredEvidence) {
    const receipt = newest.get(evidenceKey(requirement.sourceKey, requirement.subjectKey));
    if (!receipt) {
      missingEvidence.push(requirement);
      continue;
    }
    selected.push(receipt);
    if (receipt.freshUntil.getTime() <= input.now.getTime() || receipt.observedAt.getTime() > input.now.getTime()) {
      staleEvidence.push(receipt);
    }
  }

  let state: OperationalStatus;
  let reason: string;
  if (missingEvidence.length > 0 || staleEvidence.length > 0) {
    state = "GRAY";
    const reasons = [
      missingEvidence.length > 0 ? `${missingEvidence.length} required receipt(s) missing` : null,
      staleEvidence.length > 0 ? `${staleEvidence.length} required receipt(s) stale` : null,
    ].filter(Boolean);
    reason = reasons.join("; ");
  } else if (selected.some((receipt) => receipt.status === "failed")) {
    state = "RED";
    reason = `${selected.filter((receipt) => receipt.status === "failed").length} required check(s) failed`;
  } else if (selected.some((receipt) => receipt.status === "degraded")) {
    state = "YELLOW";
    reason = `${selected.filter((receipt) => receipt.status === "degraded").length} required check(s) degraded`;
  } else {
    state = "GREEN";
    reason = "All required evidence is fresh and passing";
  }

  const fingerprintInput = selected
    .map((receipt) => ({
      sourceKey: receipt.sourceKey,
      subjectKey: receipt.subjectKey,
      status: receipt.status,
      summary: receipt.summary,
      observation: receipt.observation,
    }))
    .sort((left, right) => evidenceKey(left.sourceKey, left.subjectKey).localeCompare(evidenceKey(right.sourceKey, right.subjectKey)));
  const fingerprint = createHash("sha256")
    .update(stableOperationalJson({ state, reason, missingEvidence, evidence: fingerprintInput }))
    .digest("hex");
  const observedTimes = selected.map((receipt) => receipt.observedAt.getTime());
  const freshTimes = selected.map((receipt) => receipt.freshUntil.getTime());

  return {
    state,
    reason,
    fingerprint,
    receipts: selected,
    missingEvidence,
    staleEvidence,
    observedAt: observedTimes.length > 0 ? new Date(Math.max(...observedTimes)) : null,
    freshUntil: freshTimes.length > 0 ? new Date(Math.min(...freshTimes)) : null,
  };
}

export function planOperationalTransition(input: {
  config: OperationalStatusCardConfig;
  evaluation: OperationalStatusEvaluation;
  previousFingerprint: string | null;
  previousFailureStreak: number;
  previousRecoveryStreak: number;
  hasOpenException: boolean;
}): OperationalTransition {
  const changed = input.previousFingerprint !== input.evaluation.fingerprint;
  const exceptional = input.config.exceptionPolicy.states.includes(
    input.evaluation.state as "YELLOW" | "RED" | "GRAY",
  );
  const healthy = input.evaluation.state === "GREEN";
  const failureStreak = exceptional ? input.previousFailureStreak + 1 : 0;
  const recoveryStreak = healthy ? input.previousRecoveryStreak + 1 : 0;
  return {
    changed,
    failureStreak,
    recoveryStreak,
    summaryRequired:
      changed &&
      input.config.summarizerMode === "exceptions" &&
      (input.evaluation.state === "YELLOW" || input.evaluation.state === "RED"),
    openException:
      !input.hasOpenException &&
      exceptional &&
      failureStreak >= input.config.exceptionPolicy.openAfterConsecutive,
    resolveException:
      input.hasOpenException &&
      healthy &&
      recoveryStreak >= input.config.exceptionPolicy.resolveAfterConsecutive,
  };
}

export function deterministicOperationalSummary(evaluation: OperationalStatusEvaluation) {
  const evidence = evaluation.receipts.length === 0
    ? "- No current required receipts."
    : evaluation.receipts.map((receipt) => [
        `- **${receipt.sourceKey}/${receipt.subjectKey}: ${receipt.status.toUpperCase()}** — ${receipt.summary}`,
        `  - Receipt: \`${receipt.id}\``,
        `  - Observed: ${receipt.observedAt.toISOString()}`,
        `  - Fresh until: ${receipt.freshUntil.toISOString()}`,
        `  - Provenance: \`${stableOperationalJson(receipt.provenance)}\``,
      ].join("\n")).join("\n");
  return `## ${evaluation.state}\n\n${evaluation.reason}.\n\n### Evidence\n\n${evidence}`;
}
