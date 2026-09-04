import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findBareJsonExamples,
  findInstructionGaps,
} from "./check-owner-guidance-producers.mjs";

describe("check-owner-guidance-producers", () => {
  it("flags bare request_confirmation JSON examples", () => {
    const content = `
\`\`\`json
{
  "kind": "request_confirmation",
  "payload": {
    "version": 1,
    "prompt": "Continue?"
  }
}
\`\`\`
`;
    const defects = findBareJsonExamples(content, "docs/example.md");
    assert.equal(defects.some((d) => d.code === "bare_create_example"), true);
  });

  it("accepts guided request_confirmation JSON examples", () => {
    const content = `
{
  "kind": "request_confirmation",
  "payload": {
    "version": 1,
    "prompt": "Accept plan?",
    "ownerGuidance": {
      "recommendedDisposition": "accept",
      "rationale": "ready",
      "whyHuman": "board must confirm",
      "deferConsequence": "stays waiting",
      "blastRadius": "soft",
      "decisionClass": "soft_human"
    }
  }
}
`;
    assert.deepEqual(findBareJsonExamples(content, "docs/ok.md"), []);
  });

  it("flags instruction files that teach create without ownerGuidance", () => {
    const content = `
Use POST /api/issues/{issueId}/interactions to create request_confirmation
when the board must accept a plan.
`;
    const defects = findInstructionGaps(
      content,
      "server/src/onboarding-assets/default/AGENTS.md",
    );
    assert.equal(
      defects.some((d) => d.code === "missing_owner_guidance_contract"),
      true,
    );
  });

  it("accepts instruction files with ownerGuidance contract", () => {
    const content = `
Create request_confirmation via POST /api/issues/{issueId}/interactions.
payload.ownerGuidance must include recommendedDisposition, rationale, whyHuman,
deferConsequence, blastRadius, decisionClass.
Do not escalate agent-ops or owner_terminal as bare Decide cards.
Prefer board-seat resolution for soft_human.
`;
    assert.deepEqual(
      findInstructionGaps(
        content,
        "server/src/onboarding-assets/default/AGENTS.md",
      ),
      [],
    );
  });
});
