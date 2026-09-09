import { describe, expect, it } from "vitest";
import {
  applyAnsweredRuntimeNotApplicable,
  classifyChangedPaths,
  countHumanDecisionAttentions,
  partitionBlockerEdges,
} from "./closeout-acceptance-lanes.js";

describe("closeout-acceptance-lanes", () => {
  it("classifies docs-only paths", () => {
    expect(classifyChangedPaths(["docs/tfos-execution-loop-current-state.md"])).toBe(
      "documentation",
    );
    expect(classifyChangedPaths(["server/src/index.ts", "README.md"])).toBe("mixed");
  });

  it("binds runtime N/A without waiving review or secret_scan (PAP-3221 shape)", () => {
    const lanes = applyAnsweredRuntimeNotApplicable(
      {
        ci: { laneId: "ci", state: "satisfied" },
        merge: { laneId: "merge", state: "satisfied" },
        runtime: { laneId: "runtime", state: "pending" },
        review: { laneId: "review", state: "pending" },
        secret_scan: { laneId: "secret_scan", state: "pending" },
      },
      {
        interaction: {
          id: "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
          status: "answered",
          summary: "runtime/target-host verification is inapplicable documentation-only",
          optionHint: "acceptance_revision",
        },
        pathClass: "documentation",
      },
    );
    expect(lanes.runtime?.state).toBe("not_applicable");
    expect(lanes.runtime?.bindingInteractionId).toBe(
      "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
    );
    expect(lanes.runtime?.doesNotWaive).toEqual(["review", "secret_scan"]);
    expect(lanes.review?.state).toBe("pending");
    expect(lanes.secret_scan?.state).toBe("pending");
  });

  it("clears done blocker edges", () => {
    const { controlling, cleared } = partitionBlockerEdges([
      { id: "3251", status: "done" },
      { id: "3254", status: "in_progress" },
    ]);
    expect(cleared).toHaveLength(1);
    expect(controlling).toHaveLength(1);
    expect(controlling[0]?.id).toBe("3254");
  });

  it("excludes disposition from human decision count", () => {
    expect(
      countHumanDecisionAttentions([
        { reason: "missing_successful_run_disposition" },
        { reason: "pending_board_decision" },
      ]),
    ).toBe(1);
  });
});
