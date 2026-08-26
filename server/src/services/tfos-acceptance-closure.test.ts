import { describe, expect, it } from "vitest";
import { checkTfosAcceptanceClosure, isTfosAlignGoal } from "./tfos-acceptance-closure.js";

describe("checkTfosAcceptanceClosure", () => {
  it("rejects a missing checklist", () => {
    expect(checkTfosAcceptanceClosure("No acceptance criteria yet")).toMatchObject({ allowed: false });
  });

  it("rejects unchecked or unlinked evaluations", () => {
    expect(checkTfosAcceptanceClosure("- [ ] Verified run [receipt](/PAP/runs/a)\n- [x] Evidence without link")).toMatchObject({
      allowed: false,
    });
  });

  it("allows a fully checked checklist with linked evidence per item", () => {
    expect(checkTfosAcceptanceClosure("- [x] Assignment run [receipt](/PAP/agents/a/runs/1)\n- [X] Isolated workspace [receipt](/PAP/issues/PAP-1)"))
      .toEqual({ allowed: true });
  });
});

describe("isTfosAlignGoal", () => {
  it("matches the TFOS-ALIGN goal title only", () => {
    expect(isTfosAlignGoal({ title: "TFOS-ALIGN" })).toBe(true);
    expect(isTfosAlignGoal({ title: "TFOS alignment" })).toBe(false);
  });
});
