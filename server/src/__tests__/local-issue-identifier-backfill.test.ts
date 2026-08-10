import { describe, expect, it } from "vitest";
import { buildIdentifierBackfillPlan } from "@paperclipai/shared";

describe("buildIdentifierBackfillPlan", () => {
  it("backfills local work while preserving manual and Linear mirror identifiers", () => {
    const plan = buildIdentifierBackfillPlan([
      {
        id: "local",
        companyId: "company",
        identifier: "TAN-7",
        issueNumber: 7,
        originKind: "routine_execution",
      },
      {
        id: "manual",
        companyId: "company",
        identifier: "TAN-8",
        issueNumber: 8,
        originKind: "manual",
      },
      {
        id: "linear",
        companyId: "company",
        identifier: "TAN-9",
        issueNumber: 9,
        originKind: "plugin:paperclipai.linear-sync:linear-issue",
      },
    ]);

    expect(plan.changes).toEqual([
      expect.objectContaining({
        id: "local",
        targetIdentifier: "PCL-7",
      }),
    ]);
    expect(plan.collisions).toEqual([]);
  });

  it("refuses to overwrite an existing target identifier", () => {
    const plan = buildIdentifierBackfillPlan([
      {
        id: "candidate",
        companyId: "company",
        identifier: "TAN-7",
        issueNumber: 7,
        originKind: "routine_execution",
      },
      {
        id: "existing",
        companyId: "company",
        identifier: "PCL-7",
        issueNumber: 99,
        originKind: "manual",
      },
    ]);

    expect(plan.collisions).toEqual([
      {
        targetIdentifier: "PCL-7",
        candidateId: "candidate",
        existingId: "existing",
      },
    ]);
  });

  it("detects duplicate targets across companies", () => {
    const plan = buildIdentifierBackfillPlan([
      {
        id: "candidate-a",
        companyId: "company-a",
        identifier: "TAN-7",
        issueNumber: 7,
        originKind: "routine_execution",
      },
      {
        id: "candidate-b",
        companyId: "company-b",
        identifier: "TF-7",
        issueNumber: 7,
        originKind: "stale_active_run_evaluation",
      },
    ]);

    expect(plan.collisions).toEqual([
      {
        targetIdentifier: "PCL-7",
        candidateId: "candidate-a",
        existingId: "candidate-b",
      },
    ]);
  });

  it("can scope historical remediation to one source prefix", () => {
    const plan = buildIdentifierBackfillPlan([
      {
        id: "tan",
        companyId: "company",
        identifier: "TAN-7",
        issueNumber: 7,
        originKind: "routine_execution",
      },
      {
        id: "pap",
        companyId: "company",
        identifier: "PAP-8",
        issueNumber: 8,
        originKind: "routine_execution",
      },
    ], { sourcePrefix: "TAN" });

    expect(plan.changes.map((change) => change.id)).toEqual(["tan"]);
  });
});
