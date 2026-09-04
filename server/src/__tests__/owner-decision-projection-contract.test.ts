import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateOwnerGuidanceOnCreate,
  resolveOwnerGuidanceEnforceMode,
  shouldRejectOwnerGuidanceCreate,
} from "@paperclipai/shared";

describe("owner guidance enforce path (server contract)", () => {
  const previous = process.env.PAPERCLIP_OWNER_GUIDANCE_ENFORCE;

  afterEach(() => {
    if (previous === undefined) delete process.env.PAPERCLIP_OWNER_GUIDANCE_ENFORCE;
    else process.env.PAPERCLIP_OWNER_GUIDANCE_ENFORCE = previous;
  });

  it("defaults to warn and does not reject bare creates", () => {
    delete process.env.PAPERCLIP_OWNER_GUIDANCE_ENFORCE;
    expect(resolveOwnerGuidanceEnforceMode()).toBe("warn");
    const evaluation = evaluateOwnerGuidanceOnCreate({
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Bare?" },
      mode: resolveOwnerGuidanceEnforceMode(),
    });
    expect(evaluation.producerDefect).toBe(true);
    expect(shouldRejectOwnerGuidanceCreate(evaluation)).toBe(false);
  });

  it("strict mode rejects bare human creates (F1)", () => {
    process.env.PAPERCLIP_OWNER_GUIDANCE_ENFORCE = "strict";
    const evaluation = evaluateOwnerGuidanceOnCreate({
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Bare?" },
      mode: resolveOwnerGuidanceEnforceMode(),
    });
    expect(shouldRejectOwnerGuidanceCreate(evaluation)).toBe(true);
    expect(evaluation.code).toBe("missing_owner_guidance");
  });

  it("strict mode accepts complete hard_human guidance", () => {
    process.env.PAPERCLIP_OWNER_GUIDANCE_ENFORCE = "strict";
    const evaluation = evaluateOwnerGuidanceOnCreate({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Authorize?",
        ownerGuidance: {
          recommendedDisposition: "defer",
          rationale: "No window yet.",
          whyHuman: "Force-push is owner-only.",
          deferConsequence: "Publish blocked.",
          blastRadius: "hard",
          decisionClass: "hard_human",
        },
      },
      mode: resolveOwnerGuidanceEnforceMode(),
    });
    expect(evaluation.complete).toBe(true);
    expect(shouldRejectOwnerGuidanceCreate(evaluation)).toBe(false);
  });
});
