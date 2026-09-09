import { describe, expect, it } from "vitest";
import {
  bindAnsweredInteractionToLane,
  classifyChangedPaths,
  filterControllingBlockerIds,
  isHumanOwnershipClass,
  isLaneControlling,
  runtimeLaneDefaultForPathClass,
  shouldSurfaceMissingDisposition,
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
});

describe("runtimeLaneDefaultForPathClass", () => {
  it("docs-only runtime is not_applicable", () => {
    expect(runtimeLaneDefaultForPathClass("documentation")).toBe("not_applicable");
  });

  it("executable runtime stays pending", () => {
    expect(runtimeLaneDefaultForPathClass("executable")).toBe("pending");
  });
});

describe("bindAnsweredInteractionToLane", () => {
  it("binds runtime N/A from answered interaction", () => {
    const r = bindAnsweredInteractionToLane({
      lanes: {
        independent_review: { state: "pending" },
        exact_head_secret_scan: { state: "pending" },
        runtime_target_host: { state: "pending" },
      },
      laneKey: "runtime_target_host",
      state: "not_applicable",
      interactionId: "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
      scope: { pathClass: "documentation", exactHead: "758457e" },
      updatedAt: "2026-09-09T00:45:55Z",
    });
    expect(r.applied).toBe(true);
    expect(r.lanes.runtime_target_host?.state).toBe("not_applicable");
    expect(r.lanes.runtime_target_host?.bindingInteractionId).toBe(
      "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
    );
    expect(r.lanes.independent_review?.state).toBe("pending");
    expect(r.lanes.exact_head_secret_scan?.state).toBe("pending");
  });

  it("refuses N/A on non-waivable review lane", () => {
    const r = bindAnsweredInteractionToLane({
      lanes: {},
      laneKey: "independent_review",
      state: "not_applicable",
      interactionId: "x",
    });
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_non_waivable");
  });
});

describe("filterControllingBlockerIds", () => {
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
  it("only in_progress", () => {
    expect(shouldSurfaceMissingDisposition("in_progress")).toBe(true);
    expect(shouldSurfaceMissingDisposition("todo")).toBe(false);
    expect(shouldSurfaceMissingDisposition("backlog")).toBe(false);
    expect(shouldSurfaceMissingDisposition("done")).toBe(false);
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
