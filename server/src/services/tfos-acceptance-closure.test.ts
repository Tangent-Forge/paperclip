import { describe, expect, it } from "vitest";
import { checkTfosAcceptanceClosure } from "./tfos-acceptance-closure.js";

describe("checkTfosAcceptanceClosure", () => {
  it("does not apply outside the remediation program", () => {
    expect(checkTfosAcceptanceClosure("- [ ] ordinary acceptance eval")).toEqual({ applies: false, incomplete: [] });
  });

  it("rejects unchecked and unevidenced TFOS acceptance evaluations", () => {
    expect(checkTfosAcceptanceClosure("TFOS-ALIGN\n- [x] run starts\n- [ ] failure is recorded")).toEqual({
      applies: true,
      incomplete: ["missing evidence pointer: run starts", "unchecked: failure is recorded"],
    });
  });

  it("accepts checked evaluations with durable evidence pointers", () => {
    expect(checkTfosAcceptanceClosure([
      "TFOS-ALIGN",
      "- [x] assignment run starts",
      "  - heartbeat_runs: 11111111-1111-4111-8111-111111111111",
      "- [x] close guard rejects incomplete eval",
      "  - [command receipt](https://ci.example.test/runs/17)",
    ].join("\n"))).toEqual({ applies: true, incomplete: [] });
  });
});
