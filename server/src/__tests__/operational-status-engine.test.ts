import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IngestOperationalReceipt, OperationalStatusCardConfig } from "@paperclipai/shared";
import {
  deriveOperationalReceiptStatus,
  deterministicOperationalSummary,
  evaluateOperationalStatus,
  planOperationalTransition,
  type OperationalReceiptEvidence,
} from "../services/operational-status-engine.js";

const now = new Date("2026-09-09T18:00:00.000Z");
const writerAgentId = "123e4567-e89b-42d3-a456-426614174099";
const config: OperationalStatusCardConfig = {
  requiredEvidence: [{ sourceKey: "paperclip-api", subjectKey: "health", label: "Paperclip API", writerAgentId }],
  summarizerMode: "exceptions",
  exceptionPolicy: { states: ["RED", "GRAY"], openAfterConsecutive: 2, resolveAfterConsecutive: 1 },
};

function receipt(
  status: OperationalReceiptEvidence["status"],
  overrides: Partial<OperationalReceiptEvidence> = {},
): OperationalReceiptEvidence {
  return {
    id: randomUUID(),
    sourceKey: "paperclip-api",
    subjectKey: "health",
    status,
    summary: `${status} health probe`,
    observedAt: new Date("2026-09-09T17:59:00.000Z"),
    freshUntil: new Date("2026-09-09T18:04:00.000Z"),
    provenance: { probe: "paperclip-api-health-probe", host: "TF-Home", executionId: "probe-42" },
    observation: { kind: "check", result: status, detail: { httpStatus: status === "failed" ? 503 : 200 } },
    ...overrides,
  };
}

describe("operational status engine", () => {
  it("returns GRAY deterministically when required evidence is missing or stale", () => {
    const missing = evaluateOperationalStatus({ config, receipts: [], now });
    const stale = evaluateOperationalStatus({
      config,
      receipts: [receipt("passed", { freshUntil: new Date("2026-09-09T17:59:59.000Z") })],
      now,
    });

    expect(missing).toMatchObject({ state: "GRAY", missingEvidence: [{ sourceKey: "paperclip-api" }] });
    expect(stale).toMatchObject({ state: "GRAY" });
    expect(stale.staleEvidence).toHaveLength(1);
    expect(planOperationalTransition({
      config,
      evaluation: missing,
      previousFingerprint: null,
      previousFailureStreak: 0,
      previousRecoveryStreak: 0,
      hasOpenException: false,
    }).summaryRequired).toBe(false);
  });

  it("maps fresh failed, degraded, and passing evidence to RED, YELLOW, and GREEN", () => {
    expect(evaluateOperationalStatus({ config, receipts: [receipt("failed")], now }).state).toBe("RED");
    expect(evaluateOperationalStatus({ config, receipts: [receipt("degraded")], now }).state).toBe("YELLOW");
    expect(evaluateOperationalStatus({ config, receipts: [receipt("passed")], now }).state).toBe("GREEN");
  });

  it("treats successful systemd oneshots as healthy while inactive between executions", () => {
    const observation: IngestOperationalReceipt["observation"] = {
      kind: "systemd_unit",
      unitType: "oneshot",
      activeState: "inactive",
      subState: "dead",
      result: "success",
      detail: { lastExitStatus: 0 },
    };
    expect(deriveOperationalReceiptStatus(observation)).toBe("passed");
    expect(deriveOperationalReceiptStatus({ ...observation, result: "exit-code" })).toBe("failed");
  });

  it("suppresses duplicate exceptions and resolves one after a passing recovery receipt", () => {
    const failed = evaluateOperationalStatus({ config, receipts: [receipt("failed")], now });
    const first = planOperationalTransition({
      config,
      evaluation: failed,
      previousFingerprint: null,
      previousFailureStreak: 0,
      previousRecoveryStreak: 0,
      hasOpenException: false,
    });
    const second = planOperationalTransition({
      config,
      evaluation: failed,
      previousFingerprint: failed.fingerprint,
      previousFailureStreak: first.failureStreak,
      previousRecoveryStreak: 0,
      hasOpenException: false,
    });
    const duplicate = planOperationalTransition({
      config,
      evaluation: failed,
      previousFingerprint: failed.fingerprint,
      previousFailureStreak: second.failureStreak,
      previousRecoveryStreak: 0,
      hasOpenException: true,
    });
    const recovered = evaluateOperationalStatus({ config, receipts: [receipt("passed")], now });
    const recovery = planOperationalTransition({
      config,
      evaluation: recovered,
      previousFingerprint: failed.fingerprint,
      previousFailureStreak: duplicate.failureStreak,
      previousRecoveryStreak: 0,
      hasOpenException: true,
    });

    expect(first.openException).toBe(false);
    expect(second.openException).toBe(true);
    expect(duplicate.openException).toBe(false);
    expect(recovery.resolveException).toBe(true);
  });

  it("proves the canary transition and bounds summarization to a changed exception", () => {
    const summarize = vi.fn((payload: { state: string; evidence: Array<{ receiptId: string }> }) => payload);
    const failedReceipt = receipt("failed");
    const failed = evaluateOperationalStatus({ config, receipts: [failedReceipt], now });
    const transition = planOperationalTransition({
      config,
      evaluation: failed,
      previousFingerprint: null,
      previousFailureStreak: 0,
      previousRecoveryStreak: 0,
      hasOpenException: false,
    });
    if (transition.summaryRequired) {
      summarize({
        state: failed.state,
        evidence: failed.receipts.map((entry) => ({ receiptId: entry.id })),
      });
    }
    const unchanged = planOperationalTransition({
      config,
      evaluation: failed,
      previousFingerprint: failed.fingerprint,
      previousFailureStreak: transition.failureStreak,
      previousRecoveryStreak: 0,
      hasOpenException: false,
    });
    if (unchanged.summaryRequired) summarize({ state: failed.state, evidence: [] });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith({ state: "RED", evidence: [{ receiptId: failedReceipt.id }] });
    expect(unchanged.changed).toBe(false);
    expect(deterministicOperationalSummary(failed)).toContain(`Receipt: \`${failedReceipt.id}\``);
    expect(deterministicOperationalSummary(failed)).toContain("Fresh until: 2026-09-09T18:04:00.000Z");
  });
});
