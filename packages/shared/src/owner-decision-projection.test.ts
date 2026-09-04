import { describe, expect, it } from "vitest";
import {
  blockedReasonVariantForOwnerProjection,
  buildOwnerTerminalAttentionFields,
  classifyHumanDecisionsLane,
  evaluateOwnerGuidanceOnCreate,
  isHumanDecisionsLaneItem,
  isOwnerGuidanceComplete,
  resolveOwnerGuidanceEnforceMode,
  shouldRejectOwnerGuidanceCreate,
  type OwnerGuidance,
} from "./owner-decision-projection.js";
import type { IssueBlockedInboxAttention } from "./types/issue.js";
import {
  createIssueThreadInteractionSchema,
  ownerGuidanceSchema,
  requestConfirmationPayloadSchema,
} from "./validators/issue.js";

const fullGuidance: OwnerGuidance = {
  recommendedDisposition: "defer",
  rationale: "No open rewrite window or fresh candidate yet.",
  whyHuman: "Force-push can destroy main; only the owner can bind dest/ref.",
  deferConsequence: "Publish stays blocked; local candidate work can continue.",
  blastRadius: "hard",
  decisionClass: "hard_human",
};

function attention(
  overrides: Partial<IssueBlockedInboxAttention>,
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "awaiting_decision",
    reason: "pending_board_decision",
    severity: "medium",
    stoppedSinceAt: "2026-09-04T00:00:00.000Z",
    owner: { type: "board", agentId: null, userId: null, label: "Board" },
    action: { label: "Answer", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

describe("ownerGuidance contract (F1/F6)", () => {
  it("accepts complete hard_human guidance", () => {
    expect(isOwnerGuidanceComplete(fullGuidance)).toBe(true);
    expect(ownerGuidanceSchema.parse(fullGuidance).decisionClass).toBe("hard_human");
  });

  it("rejects hard_human with non-hard blast radius", () => {
    expect(() =>
      ownerGuidanceSchema.parse({ ...fullGuidance, blastRadius: "soft" }),
    ).toThrow();
  });

  it("F1: bare request_confirmation is still parseable (grandfather storage) but create-eval is a producer defect", () => {
    const bare = requestConfirmationPayloadSchema.parse({
      version: 1,
      prompt: "Legacy bare card?",
    });
    expect(bare.ownerGuidance).toBeUndefined();

    const evalWarn = evaluateOwnerGuidanceOnCreate({
      kind: "request_confirmation",
      payload: bare as unknown as Record<string, unknown>,
      mode: "warn",
    });
    expect(evalWarn.producerDefect).toBe(true);
    expect(evalWarn.code).toBe("missing_owner_guidance");
    expect(shouldRejectOwnerGuidanceCreate(evalWarn)).toBe(false);

    const evalStrict = evaluateOwnerGuidanceOnCreate({
      kind: "request_confirmation",
      payload: bare as unknown as Record<string, unknown>,
      mode: "strict",
    });
    expect(shouldRejectOwnerGuidanceCreate(evalStrict)).toBe(true);
  });

  it("F1: create with full ownerGuidance is contract-complete", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Authorize rewrite?",
        ownerGuidance: fullGuidance,
      },
    });
    const evaluation = evaluateOwnerGuidanceOnCreate({
      kind: parsed.kind,
      payload: parsed.payload as unknown as Record<string, unknown>,
      mode: "strict",
    });
    expect(evaluation.complete).toBe(true);
    expect(evaluation.producerDefect).toBe(false);
    expect(shouldRejectOwnerGuidanceCreate(evaluation)).toBe(false);
  });

  it("F2: soft_human guidance is accepted", () => {
    const soft: OwnerGuidance = {
      recommendedDisposition: "accept",
      rationale: "Watchdogs are board-seat only and already prepared.",
      whyHuman: "Cross-assignee arm and fleet noise need owner spend authority.",
      deferConsequence: "Phase stays doc-only; no canary spend.",
      blastRadius: "soft",
      decisionClass: "soft_human",
      systemAlternative: "Prefer board-seat arm before escalating a soft_human card.",
    };
    expect(isOwnerGuidanceComplete(soft)).toBe(true);
  });

  it("does not invent guidance server-side for incomplete objects", () => {
    const evaluation = evaluateOwnerGuidanceOnCreate({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Go?",
        ownerGuidance: { decisionClass: "hard_human" },
      },
      mode: "strict",
    });
    expect(evaluation.complete).toBe(false);
    expect(evaluation.producerDefect).toBe(true);
    expect(evaluation.message).toMatch(/incomplete|hard_human|ownerGuidance/i);
  });

  it("defaults enforce mode to warn", () => {
    expect(resolveOwnerGuidanceEnforceMode({})).toBe("warn");
    expect(resolveOwnerGuidanceEnforceMode({ PAPERCLIP_OWNER_GUIDANCE_ENFORCE: "strict" })).toBe(
      "strict",
    );
  });
});

describe("Human Decisions lane projection (F3–F8)", () => {
  it("F3: disposition is excluded from Human Decisions and not needs_decision", () => {
    const a = attention({
      reason: "missing_successful_run_disposition",
      owner: { type: "agent", agentId: "a", userId: null, label: null },
      state: "missing_disposition",
    });
    const c = classifyHumanDecisionsLane(a);
    expect(c.inHumanDecisionsLane).toBe(false);
    expect(c.object).toBe("excluded_agent_ops");
    expect(blockedReasonVariantForOwnerProjection(a.reason)).toBe("needs_disposition");
  });

  it("F4: owner_terminal is not a Decide bucket and has no fake action flag", () => {
    const a = attention({
      reason: "owner_terminal",
      owner: { type: "user", agentId: null, userId: "local-board", label: null },
      interactionId: null,
      action: {
        label: "Owner terminal",
        detail: "Blocked on owner terminal PAP-2984: post PR 339 auth packet",
      },
    });
    const c = classifyHumanDecisionsLane(a);
    expect(c.inHumanDecisionsLane).toBe(false);
    expect(c.object).toBe("excluded_owner_terminal");
    expect(c.hasFakeDecideAction).toBe(false);
    expect(blockedReasonVariantForOwnerProjection("owner_terminal")).toBe("owner_terminal");

    const fields = buildOwnerTerminalAttentionFields({
      terminalIssueId: "t1",
      terminalIdentifier: "PAP-2984",
      requiredOwnerAction: "post PR 339 auth packet",
      hasPendingOwnerInteraction: false,
    });
    expect(fields.reason).toBe("owner_terminal");
    expect(fields.action.detail).toMatch(/not a Decide action/);
  });

  it("F5: formal approval remains in Human Decisions", () => {
    const a = attention({
      reason: "pending_board_decision",
      approvalId: "11111111-1111-4111-8111-111111111111",
      interactionId: null,
      owner: { type: "board", agentId: null, userId: null, label: "Board" },
    });
    expect(isHumanDecisionsLaneItem(a)).toBe(true);
    expect(classifyHumanDecisionsLane(a).object).toBe("formal_approval");
  });

  it("F1/F2 pending interaction with board owner stays in Human Decisions", () => {
    const a = attention({
      reason: "pending_board_decision",
      interactionId: "22222222-2222-4222-8222-222222222222",
      owner: { type: "board", agentId: null, userId: null, label: "Board" },
    });
    expect(isHumanDecisionsLaneItem(a)).toBe(true);
    expect(classifyHumanDecisionsLane(a).object).toBe("pending_interaction");
  });

  it("F7/F8: stalled agent chain and external waits are not human needs_decision", () => {
    expect(
      isHumanDecisionsLaneItem(
        attention({
          reason: "blocked_chain_stalled",
          owner: { type: "agent", agentId: "a", userId: null, label: null },
        }),
      ),
    ).toBe(false);
    expect(blockedReasonVariantForOwnerProjection("blocked_chain_stalled")).toBe("stalled");
    expect(
      isHumanDecisionsLaneItem(
        attention({
          reason: "external_owner_action",
          owner: { type: "external", agentId: null, userId: null, label: "GitHub" },
        }),
      ),
    ).toBe(false);
  });
});
