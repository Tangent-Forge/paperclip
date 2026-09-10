import { describe, expect, it } from "vitest";
import {
  bindAnsweredInteractionToLane,
  buildAgentOpsDispositionDebtItem,
  classifyChangedPaths,
  evaluateRuntimeNaEligibility,
  filterControllingBlockerIds,
  isHumanOwnershipClass,
  isLaneControlling,
  runtimeLaneDefaultForPathClass,
  shouldSurfaceMissingDisposition,
  STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
  summarizeAgentOpsDispositionDebt,
  toCanonicalPathClass,
} from "./acceptance-lanes.js";

describe("classifyChangedPaths", () => {
  it("marks single markdown as documentation", () => {
    expect(classifyChangedPaths(["docs/tfos-execution-loop-current-state.md"])).toBe(
      "documentation",
    );
  });

  it("marks code as executable", () => {
    expect(classifyChangedPaths(["server/src/routes/issues.ts"])).toBe("executable");
  });

  it("marks mixed sets as mixed", () => {
    expect(
      classifyChangedPaths(["docs/a.md", "server/src/x.ts"]),
    ).toBe("mixed");
  });

  it("maps short class to hub canonical vocabulary", () => {
    expect(toCanonicalPathClass("tests")).toBe("tests_evaluation");
    expect(toCanonicalPathClass("executable")).toBe("executable_runtime");
    expect(toCanonicalPathClass("documentation")).toBe("documentation");
  });
});

describe("runtimeLaneDefaultForPathClass (fail closed)", () => {
  it("docs-only path class stays pending without policy/decision", () => {
    expect(runtimeLaneDefaultForPathClass("documentation")).toBe("pending");
  });

  it("generated path class stays pending", () => {
    expect(runtimeLaneDefaultForPathClass("generated")).toBe("pending");
  });

  it("executable runtime stays pending", () => {
    expect(runtimeLaneDefaultForPathClass("executable")).toBe("pending");
  });
});

describe("evaluateRuntimeNaEligibility", () => {
  it("refuses documentation path alone", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      pathClass: "documentation",
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_path_only");
  });

  it("refuses generated without policy", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      pathClass: "generated",
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_generated_default");
  });

  it("allows docs-only via named standing policy", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      pathClass: "documentation",
      standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
    });
    expect(r.eligible).toBe(true);
    expect(r.code).toBe("ok_standing_policy");
  });

  it("refuses generated even with docs-only standing policy", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      pathClass: "generated",
      standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_generated_default");
  });

  it("refuses merely answered decision", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "ix-1",
        resolutionStatus: "answered",
        laneKey: "runtime_target_host",
        option: "runtime_not_applicable",
        exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58",
      },
      expected: { exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58", laneKey: "runtime_target_host" },
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_decision_not_accepted");
  });

  it("refuses rejected decision", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "ix-rej",
        resolutionStatus: "rejected",
        laneKey: "runtime_target_host",
        option: "runtime_not_applicable",
        exactHead: "abc",
      },
      expected: { exactHead: "abc" },
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_decision_rejected");
  });

  it("refuses expired decision", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "ix-exp",
        resolutionStatus: "accepted",
        laneKey: "runtime_target_host",
        option: "runtime_not_applicable",
        exactHead: "abc",
        expiresAt: "2020-01-01T00:00:00Z",
      },
      expected: { exactHead: "abc" },
      nowIso: "2026-09-09T00:00:00Z",
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_decision_expired");
  });

  it("refuses exact-head mismatch", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "ix-h",
        resolutionStatus: "accepted",
        laneKey: "runtime_target_host",
        option: "runtime_not_applicable",
        exactHead: "1111111111111111111111111111111111111111",
      },
      expected: { exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58" },
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_exact_head_mismatch");
  });

  it("refuses artifact mismatch", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "ix-a",
        resolutionStatus: "accepted",
        laneKey: "runtime_target_host",
        option: "runtime_not_applicable",
        artifactRef: "other-pr",
        exactHead: "758457e",
      },
      expected: { artifactRef: "pr-491", exactHead: "758457e" },
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_artifact_mismatch");
  });

  it("refuses lane mismatch", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "ix-l",
        resolutionStatus: "accepted",
        laneKey: "ci",
        option: "runtime_not_applicable",
        exactHead: "758457e",
      },
      expected: { laneKey: "runtime_target_host", exactHead: "758457e" },
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_lane_mismatch");
  });

  it("accepts matching accepted decision (PAP-3221 shape)", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
        resolutionStatus: "accepted",
        decisionStatus: "approved",
        laneKey: "runtime_target_host",
        option: "runtime_not_applicable",
        exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58",
        artifactRef: "Tangent-Forge/agent-systems-hub#491",
        issueId: "PAP-3221",
        pathClass: "documentation",
      },
      expected: {
        exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58",
        artifactRef: "Tangent-Forge/agent-systems-hub#491",
        issueId: "PAP-3221",
        laneKey: "runtime_target_host",
      },
    });
    expect(r.eligible).toBe(true);
    expect(r.code).toBe("ok_accepted_decision");
  });

  it("allows historical acceptance_revision only for runtime lane with exactHead", () => {
    const ok = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
        resolutionStatus: "accepted",
        laneKey: "runtime_target_host",
        option: "acceptance_revision",
        exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58",
        decisionId: "DEC-PAP2585-3221-1",
      },
      expected: {
        exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58",
        laneKey: "runtime_target_host",
      },
    });
    expect(ok.eligible).toBe(true);

    const bare = evaluateRuntimeNaEligibility({
      laneKey: "independent_review",
      decision: {
        interactionId: "ix-bare",
        resolutionStatus: "accepted",
        laneKey: "independent_review",
        option: "acceptance_revision",
      },
    });
    expect(bare.eligible).toBe(false);
    // non-waivable lane refuses before option checks
    expect(bare.code).toBe("refused_non_waivable_lane");

    const bareCi = evaluateRuntimeNaEligibility({
      laneKey: "ci",
      decision: {
        interactionId: "ix-bare-ci",
        resolutionStatus: "accepted",
        laneKey: "ci",
        option: "acceptance_revision",
      },
    });
    expect(bareCi.eligible).toBe(false);
    expect(bareCi.code).toBe("refused_unrelated_option");

    const noHead = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      decision: {
        interactionId: "ix-nh",
        resolutionStatus: "accepted",
        laneKey: "runtime_target_host",
        option: "acceptance_revision",
      },
    });
    expect(noHead.eligible).toBe(false);
    expect(noHead.code).toBe("refused_unrelated_option");
  });

  it("refuses invented standing policy strings not in trusted registry", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      pathClass: "documentation",
      standingPolicyId: "ownerGuidance-invented-policy",
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_unrecognized_policy");
  });

  it("refuses standing policy when pathClass is missing from trusted target", () => {
    const r = evaluateRuntimeNaEligibility({
      laneKey: "runtime_target_host",
      pathClass: null,
      standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
    });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("refused_path_only");
  });
});

describe("bindAnsweredInteractionToLane", () => {
  const baseLanes = {
    independent_review: { state: "pending" as const },
    exact_head_secret_scan: { state: "pending" as const },
    runtime_target_host: { state: "pending" as const },
  };

  it("binds runtime N/A from accepted structured decision", () => {
    const r = bindAnsweredInteractionToLane({
      lanes: { ...baseLanes },
      laneKey: "runtime_target_host",
      state: "not_applicable",
      interactionId: "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
      resolutionStatus: "accepted",
      scope: {
        pathClass: "documentation",
        exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58",
        artifact: "Tangent-Forge/agent-systems-hub#491",
        issueId: "PAP-3221",
      },
      runtimeNa: {
        decision: {
          interactionId: "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
          resolutionStatus: "accepted",
          laneKey: "runtime_target_host",
          option: "runtime_not_applicable",
          exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58",
          artifactRef: "Tangent-Forge/agent-systems-hub#491",
          issueId: "PAP-3221",
        },
        expected: {
          exactHead: "758457e40184c86410ab57c07a035ab1a4a7ae58",
          artifactRef: "Tangent-Forge/agent-systems-hub#491",
          issueId: "PAP-3221",
        },
      },
      updatedAt: "2026-09-09T00:45:55Z",
    });
    expect(r.applied).toBe(true);
    expect(r.lanes.runtime_target_host?.state).toBe("not_applicable");
    expect(r.lanes.independent_review?.state).toBe("pending");
    expect(r.lanes.exact_head_secret_scan?.state).toBe("pending");
  });

  it("refuses runtime N/A when only answered", () => {
    const r = bindAnsweredInteractionToLane({
      lanes: { ...baseLanes },
      laneKey: "runtime_target_host",
      state: "not_applicable",
      interactionId: "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
      resolutionStatus: "answered",
      scope: { pathClass: "documentation", exactHead: "758457e" },
    });
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_decision_not_accepted");
  });

  it("refuses docs-only without standing policy or accepted decision", () => {
    const r = bindAnsweredInteractionToLane({
      lanes: { ...baseLanes },
      laneKey: "runtime_target_host",
      state: "not_applicable",
      interactionId: "x",
      resolutionStatus: "answered",
      scope: { pathClass: "documentation" },
      runtimeNa: { pathClass: "documentation" },
    });
    expect(r.applied).toBe(false);
    expect(["refused_path_only", "refused_decision_not_accepted", "refused_no_authority"]).toContain(
      r.code,
    );
  });

  it("allows runtime N/A via standing policy for documentation", () => {
    const r = bindAnsweredInteractionToLane({
      lanes: { ...baseLanes },
      laneKey: "runtime_target_host",
      state: "not_applicable",
      interactionId: "policy-bind",
      scope: { pathClass: "documentation" },
      runtimeNa: {
        pathClass: "documentation",
        standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
      },
    });
    expect(r.applied).toBe(true);
    expect(r.lanes.runtime_target_host?.standingPolicyId).toBe(
      STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
    );
  });

  it("refuses N/A on non-waivable review lane", () => {
    const r = bindAnsweredInteractionToLane({
      lanes: {},
      laneKey: "independent_review",
      state: "not_applicable",
      interactionId: "x",
      resolutionStatus: "accepted",
    });
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_non_waivable");
  });

  it("refuses N/A on secret_scan lane", () => {
    const r = bindAnsweredInteractionToLane({
      lanes: {},
      laneKey: "exact_head_secret_scan",
      state: "not_applicable",
      interactionId: "x",
      resolutionStatus: "accepted",
    });
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_non_waivable");
  });
});

describe("filterControllingBlockerIds (pure helper; Phase 3 wires service)", () => {
  it("drops done and cancelled edges", () => {
    const r = filterControllingBlockerIds(
      ["a", "b", "c"],
      { a: "done", b: "in_progress", c: "cancelled" },
    );
    expect(r.controlling).toEqual(["b"]);
    expect(r.satisfied).toEqual(["a", "c"]);
  });
});

describe("shouldSurfaceMissingDisposition", () => {
  it("allows in_progress and in_review only", () => {
    expect(shouldSurfaceMissingDisposition("in_progress")).toBe(true);
    expect(shouldSurfaceMissingDisposition("in_review")).toBe(true);
    expect(shouldSurfaceMissingDisposition("todo")).toBe(false);
    expect(shouldSurfaceMissingDisposition("backlog")).toBe(false);
    expect(shouldSurfaceMissingDisposition("done")).toBe(false);
    expect(shouldSurfaceMissingDisposition("blocked")).toBe(false);
  });
});

describe("Agent Ops disposition debt", () => {
  it("builds debt item excluded from Human Decisions", () => {
    const item = buildAgentOpsDispositionDebtItem({
      issueId: "iss-1",
      issueIdentifier: "PAP-1",
      issueStatus: "in_progress",
      companyId: "co-1",
      stoppedSinceAt: "2026-09-09T00:00:00.000Z",
      sourceRunId: "run-1",
      assigneeAgentId: "agent-1",
      nowMs: Date.parse("2026-09-09T01:00:00.000Z"),
    });
    expect(item.inHumanDecisionsLane).toBe(false);
    expect(item.inAgentOpsLane).toBe(true);
    expect(item.reason).toBe("missing_successful_run_disposition");
    expect(item.ageMs).toBe(3_600_000);
    expect(item.sourceRunId).toBe("run-1");
    expect(item.requiredNextDisposition).toBe("done");
  });

  it("summarizes counts and oldest age", () => {
    const items = [
      buildAgentOpsDispositionDebtItem({
        issueId: "a",
        issueStatus: "in_progress",
        companyId: "c",
        stoppedSinceAt: "2026-09-09T00:00:00.000Z",
        nowMs: Date.parse("2026-09-09T02:00:00.000Z"),
      }),
      buildAgentOpsDispositionDebtItem({
        issueId: "b",
        issueStatus: "in_review",
        companyId: "c",
        stoppedSinceAt: "2026-09-09T01:00:00.000Z",
        nowMs: Date.parse("2026-09-09T02:00:00.000Z"),
      }),
    ];
    const s = summarizeAgentOpsDispositionDebt(items);
    expect(s.count).toBe(2);
    expect(s.oldestAgeMs).toBe(7_200_000);
  });
});

describe("ownership helpers", () => {
  it("flags human classes", () => {
    expect(isHumanOwnershipClass("authority_change")).toBe(true);
    expect(isHumanOwnershipClass("evidence_based")).toBe(false);
  });
  it("controlling states", () => {
    expect(isLaneControlling("pending")).toBe(true);
    expect(isLaneControlling("not_applicable")).toBe(false);
  });
});

describe("parity fixture vs evaluateRuntimeNaEligibility", () => {
  it("matches shared fixture cases", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturePath = join(here, "../fixtures/acceptance_lane_parity_cases.json");
    const data = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      cases: Array<{
        id: string;
        laneKey: string;
        pathClass?: string;
        standingPolicyId?: string;
        nowIso?: string;
        decision?: {
          interactionId: string;
          resolutionStatus: string;
          decisionStatus?: string;
          laneKey: string;
          option?: string;
          exactHead?: string;
          artifactRef?: string;
          issueId?: string;
          pathClass?: string;
          expiresAt?: string;
        };
        expected?: {
          exactHead?: string;
          artifactRef?: string;
          issueId?: string;
          laneKey?: string;
        };
        expectEligible: boolean;
        expectCode: string;
      }>;
    };
    for (const c of data.cases) {
      const r = evaluateRuntimeNaEligibility({
        laneKey: c.laneKey,
        pathClass: (c.pathClass as any) ?? c.decision?.pathClass as any,
        standingPolicyId: c.standingPolicyId,
        nowIso: c.nowIso,
        decision: c.decision
          ? {
              interactionId: c.decision.interactionId,
              resolutionStatus: c.decision.resolutionStatus as any,
              decisionStatus: c.decision.decisionStatus as any,
              laneKey: c.decision.laneKey,
              option: c.decision.option,
              exactHead: c.decision.exactHead,
              artifactRef: c.decision.artifactRef,
              issueId: c.decision.issueId,
              pathClass: c.decision.pathClass as any,
              expiresAt: c.decision.expiresAt,
            }
          : null,
        expected: c.expected,
      });
      expect(r.eligible, c.id).toBe(c.expectEligible);
      expect(r.code, c.id).toBe(c.expectCode);
    }
  });
});
