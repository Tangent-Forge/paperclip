import { describe, expect, it } from "vitest";
import {
  ingestOperationalReceiptSchema,
  operationalStatusCardConfigSchema,
  statusCardRefreshPolicySchema,
  writeOperationalStatusCardSummarySchema,
} from "./status-card.js";

describe("statusCardRefreshPolicySchema", () => {
  it("accepts valid IANA timezones", () => {
    expect(statusCardRefreshPolicySchema.parse({
      mode: "interval",
      intervalMinutes: 15,
      activeHours: { start: "09:00", end: "17:00", timezone: "America/New_York" },
    }).activeHours?.timezone).toBe("America/New_York");
  });

  it("rejects invalid timezone identifiers", () => {
    const result = statusCardRefreshPolicySchema.safeParse({
      mode: "interval",
      intervalMinutes: 15,
      activeHours: { start: "09:00", end: "17:00", timezone: "Not/A_Timezone" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Invalid timezone identifier" })]));
    }
  });
});

describe("operational status-card schemas", () => {
  it("rejects duplicate evidence requirements", () => {
    const requirement = { sourceKey: "api", subjectKey: "health", label: "API" };
    expect(operationalStatusCardConfigSchema.safeParse({ requiredEvidence: [requirement, requirement] }).success).toBe(false);
  });

  it("keeps receipt writers observation-only", () => {
    const base = {
      receiptId: "a4af778a-65c0-4c25-82f7-a658407fe5b6",
      sourceKey: "api",
      subjectKey: "health",
      summary: "HTTP 200",
      observedAt: "2026-09-09T18:00:00.000Z",
      freshUntil: "2026-09-09T18:05:00.000Z",
      provenance: { probe: "api-health-probe" },
      observation: { kind: "check", result: "passed", detail: { httpStatus: 200 } },
    };
    expect(ingestOperationalReceiptSchema.parse(base).receiptId).toBe(base.receiptId);
    expect(ingestOperationalReceiptSchema.safeParse({ ...base, restartService: true }).success).toBe(false);
    expect(ingestOperationalReceiptSchema.safeParse({ ...base, freshUntil: base.observedAt }).success).toBe(false);
  });

  it("does not let a summarizer choose the operational state", () => {
    const summary = {
      markdown: "The server-calculated state is RED.",
      changeSummary: "Explain failed evidence",
      generationIssueId: "123e4567-e89b-12d3-a456-426614174000",
      claimId: "123e4567-e89b-12d3-a456-426614174001",
      fingerprint: "a".repeat(64),
      model: "gpt-5.4",
    };
    expect(writeOperationalStatusCardSummarySchema.parse(summary).markdown).toContain("RED");
    expect(writeOperationalStatusCardSummarySchema.safeParse({ ...summary, state: "GREEN" }).success).toBe(false);
  });
});
