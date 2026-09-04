/**
 * Owner Decision Projection v1 (Owner Decision Projection v1)
 *
 * Additive ownerGuidance contract + pure projection helpers for the Human
 * Decisions lane. No silent guidance synthesis: incomplete human creates are
 * either warned (canary) or rejected (strict).
 */

import type { IssueBlockedInboxAttention, IssueBlockedInboxReason } from "./types/issue.js";

export const OWNER_GUIDANCE_ENFORCE_MODES = ["warn", "strict"] as const;
export type OwnerGuidanceEnforceMode = (typeof OWNER_GUIDANCE_ENFORCE_MODES)[number];

export const OWNER_DECISION_CLASSES = [
  "hard_human",
  "soft_human",
  "agent_ops",
  "informational_blocker",
] as const;
export type OwnerDecisionClass = (typeof OWNER_DECISION_CLASSES)[number];

export const OWNER_BLAST_RADII = ["hard", "soft", "none"] as const;
export type OwnerBlastRadius = (typeof OWNER_BLAST_RADII)[number];

export const OWNER_RECOMMENDED_DISPOSITIONS = ["accept", "reject", "defer", "custom"] as const;
export type OwnerRecommendedDisposition = (typeof OWNER_RECOMMENDED_DISPOSITIONS)[number];

export interface OwnerGuidance {
  recommendedDisposition: OwnerRecommendedDisposition;
  recommendedOptionId?: string | null;
  recommendedLabel?: string | null;
  rationale: string;
  whyHuman: string;
  deferConsequence: string;
  systemAlternative?: string | null;
  blastRadius: OwnerBlastRadius;
  decisionClass: OwnerDecisionClass;
}

export const OWNER_GUIDANCE_TEXT_MAX = 500;

/** Env key for live create path. Default warn-first canary; set strict after producer proof. */
export const OWNER_GUIDANCE_ENFORCE_ENV = "PAPERCLIP_OWNER_GUIDANCE_ENFORCE";

export function resolveOwnerGuidanceEnforceMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): OwnerGuidanceEnforceMode {
  const raw = (env[OWNER_GUIDANCE_ENFORCE_ENV] ?? "warn").trim().toLowerCase();
  if (raw === "strict" || raw === "on" || raw === "1" || raw === "true") return "strict";
  return "warn";
}

export function isOwnerGuidanceComplete(value: unknown): value is OwnerGuidance {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  if (!OWNER_RECOMMENDED_DISPOSITIONS.includes(g.recommendedDisposition as OwnerRecommendedDisposition)) {
    return false;
  }
  if (!OWNER_BLAST_RADII.includes(g.blastRadius as OwnerBlastRadius)) return false;
  if (!OWNER_DECISION_CLASSES.includes(g.decisionClass as OwnerDecisionClass)) return false;
  for (const key of ["rationale", "whyHuman", "deferConsequence"] as const) {
    const text = g[key];
    if (typeof text !== "string" || text.trim().length < 1 || text.trim().length > OWNER_GUIDANCE_TEXT_MAX) {
      return false;
    }
  }
  if (g.decisionClass === "hard_human" && g.blastRadius !== "hard") return false;
  if (g.decisionClass === "soft_human" && g.blastRadius === "hard") return false;
  return true;
}

export type OwnerGuidanceCreateKind =
  | "request_confirmation"
  | "ask_user_questions"
  | "request_checkbox_confirmation";

export interface OwnerGuidanceCreateEvaluation {
  mode: OwnerGuidanceEnforceMode;
  kind: OwnerGuidanceCreateKind;
  decisionClass: OwnerDecisionClass | null;
  requiresGuidance: boolean;
  complete: boolean;
  /** True when this create would be rejected under strict mode. */
  producerDefect: boolean;
  /** Structured code for logs / 422 details. Never invents guidance. */
  code:
    | "ok"
    | "ok_non_human_class"
    | "ok_legacy_optional"
    | "missing_owner_guidance"
    | "incomplete_owner_guidance"
    | "invalid_hard_blast_radius"
    | "invalid_soft_blast_radius";
  message: string | null;
}

function readDecisionClass(payload: Record<string, unknown> | null | undefined): OwnerDecisionClass | null {
  const guidance = payload?.ownerGuidance;
  if (!guidance || typeof guidance !== "object") return null;
  const dc = (guidance as Record<string, unknown>).decisionClass;
  if (typeof dc === "string" && OWNER_DECISION_CLASSES.includes(dc as OwnerDecisionClass)) {
    return dc as OwnerDecisionClass;
  }
  return null;
}

/**
 * Evaluate a create payload for ownerGuidance completeness.
 * Does NOT synthesize guidance. agent_ops / informational_blocker should not be
 * created as human Decide interactions; when they are, they are producer defects.
 */
export function evaluateOwnerGuidanceOnCreate(input: {
  kind: string;
  payload?: Record<string, unknown> | null;
  mode?: OwnerGuidanceEnforceMode;
}): OwnerGuidanceCreateEvaluation {
  const mode = input.mode ?? resolveOwnerGuidanceEnforceMode();
  const kind = input.kind as OwnerGuidanceCreateKind;
  const humanKinds: OwnerGuidanceCreateKind[] = [
    "request_confirmation",
    "ask_user_questions",
    "request_checkbox_confirmation",
  ];
  if (!humanKinds.includes(kind)) {
    return {
      mode,
      kind: "request_confirmation",
      decisionClass: null,
      requiresGuidance: false,
      complete: true,
      producerDefect: false,
      code: "ok_non_human_class",
      message: null,
    };
  }

  const payload = input.payload ?? {};
  const guidanceRaw = payload.ownerGuidance;
  const decisionClass = readDecisionClass(payload);

  // Explicit agent_ops / informational_blocker on a Decide kind = producer defect
  if (decisionClass === "agent_ops" || decisionClass === "informational_blocker") {
    return {
      mode,
      kind,
      decisionClass,
      requiresGuidance: false,
      complete: false,
      producerDefect: true,
      code: "missing_owner_guidance",
      message:
        `decisionClass ${decisionClass} must not create a human Decide interaction; ` +
        "route to agent ops or owner_terminal projection instead",
    };
  }

  const requiresGuidance =
    decisionClass === "hard_human"
    || decisionClass === "soft_human"
    // New human creates without class still require guidance under the v1 contract
    // (producers must classify). Bare payloads without ownerGuidance are defects.
    || guidanceRaw === undefined
    || guidanceRaw === null
    || decisionClass === null;

  if (!requiresGuidance && decisionClass && (decisionClass === "hard_human" || decisionClass === "soft_human")) {
    // unreachable — kept for clarity
  }

  // If producer omitted ownerGuidance entirely → defect for new human kinds
  if (guidanceRaw === undefined || guidanceRaw === null) {
    return {
      mode,
      kind,
      decisionClass: null,
      requiresGuidance: true,
      complete: false,
      producerDefect: true,
      code: "missing_owner_guidance",
      message:
        "New human decision interactions require structured ownerGuidance "
        + "(recommendedDisposition, rationale, whyHuman, deferConsequence, blastRadius, decisionClass). "
        + "Do not put recommendation only in detailsMarkdown.",
    };
  }

  if (!isOwnerGuidanceComplete(guidanceRaw)) {
    const g = guidanceRaw as Record<string, unknown>;
    if (g.decisionClass === "hard_human" && g.blastRadius !== "hard") {
      return {
        mode,
        kind,
        decisionClass: "hard_human",
        requiresGuidance: true,
        complete: false,
        producerDefect: true,
        code: "invalid_hard_blast_radius",
        message: "hard_human requires blastRadius hard",
      };
    }
    if (g.decisionClass === "soft_human" && g.blastRadius === "hard") {
      return {
        mode,
        kind,
        decisionClass: "soft_human",
        requiresGuidance: true,
        complete: false,
        producerDefect: true,
        code: "invalid_soft_blast_radius",
        message: "soft_human cannot use blastRadius hard",
      };
    }
    return {
      mode,
      kind,
      decisionClass,
      requiresGuidance: true,
      complete: false,
      producerDefect: true,
      code: "incomplete_owner_guidance",
      message:
        "ownerGuidance is incomplete; required fields: recommendedDisposition, rationale, "
        + "whyHuman, deferConsequence, blastRadius, decisionClass (hard_human|soft_human)",
    };
  }

  return {
    mode,
    kind,
    decisionClass: (guidanceRaw as OwnerGuidance).decisionClass,
    requiresGuidance: true,
    complete: true,
    producerDefect: false,
    code: "ok",
    message: null,
  };
}

/** Whether create should hard-fail (422) given evaluation. */
export function shouldRejectOwnerGuidanceCreate(evaluation: OwnerGuidanceCreateEvaluation): boolean {
  return evaluation.mode === "strict" && evaluation.producerDefect;
}

// --- Human Decisions lane projection (pure; independent of UI rendering) ---

export type HumanDecisionsLaneObject =
  | "pending_interaction"
  | "formal_approval"
  | "excluded_agent_ops"
  | "excluded_owner_terminal"
  | "excluded_other";

export interface HumanDecisionsLaneClassification {
  inHumanDecisionsLane: boolean;
  object: HumanDecisionsLaneObject;
  reason: IssueBlockedInboxReason;
  /** Fake Decide is forbidden when true (informational terminal only). */
  hasFakeDecideAction: boolean;
}

/**
 * Pure Human Decisions lane filter.
 * Includes only genuine pending human interactions and formal approvals.
 * Excludes disposition bookkeeping, owner_terminal chips, stalled agent chains.
 */
export function classifyHumanDecisionsLane(
  attention: Pick<
    IssueBlockedInboxAttention,
    "reason" | "owner" | "interactionId" | "approvalId" | "action"
  >,
): HumanDecisionsLaneClassification {
  const reason = attention.reason;

  if (reason === "missing_successful_run_disposition") {
    return {
      inHumanDecisionsLane: false,
      object: "excluded_agent_ops",
      reason,
      hasFakeDecideAction: false,
    };
  }

  if (reason === "owner_terminal") {
    return {
      inHumanDecisionsLane: false,
      object: "excluded_owner_terminal",
      reason,
      hasFakeDecideAction: false,
    };
  }

  if (
    reason === "blocked_chain_stalled"
    || reason === "blocked_by_unassigned_issue"
    || reason === "blocked_by_assigned_backlog_issue"
    || reason === "blocked_by_uninvokable_assignee"
    || reason === "blocked_by_cancelled_issue"
    || reason === "in_review_without_action_path"
    || reason === "invalid_review_participant"
    || reason === "open_recovery_issue"
  ) {
    return {
      inHumanDecisionsLane: false,
      object: "excluded_other",
      reason,
      hasFakeDecideAction: false,
    };
  }

  if (reason === "pending_user_decision" || reason === "pending_board_decision") {
    if (attention.approvalId && !attention.interactionId) {
      return {
        inHumanDecisionsLane: true,
        object: "formal_approval",
        reason,
        hasFakeDecideAction: false,
      };
    }
    if (attention.interactionId) {
      const ownerOk = attention.owner.type === "user" || attention.owner.type === "board";
      return {
        inHumanDecisionsLane: ownerOk,
        object: "pending_interaction",
        reason,
        hasFakeDecideAction: false,
      };
    }
    // pending_* reason without interaction or approval — not a real Decide object
    return {
      inHumanDecisionsLane: false,
      object: "excluded_other",
      reason,
      hasFakeDecideAction: false,
    };
  }

  if (reason === "external_owner_action") {
    return {
      inHumanDecisionsLane: false,
      object: "excluded_other",
      reason,
      hasFakeDecideAction: false,
    };
  }

  return {
    inHumanDecisionsLane: false,
    object: "excluded_other",
    reason,
    hasFakeDecideAction: false,
  };
}

export function isHumanDecisionsLaneItem(
  attention: Pick<
    IssueBlockedInboxAttention,
    "reason" | "owner" | "interactionId" | "approvalId" | "action"
  >,
): boolean {
  return classifyHumanDecisionsLane(attention).inHumanDecisionsLane;
}

/** Variant remap: disposition is agent ops, not needs_decision. */
export function blockedReasonVariantForOwnerProjection(
  reason: IssueBlockedInboxReason,
): "needs_decision" | "needs_attention" | "stalled" | "needs_disposition" | "owner_terminal" | "recovery_required" | "external_wait" | "owner_paused" {
  switch (reason) {
    case "pending_board_decision":
    case "pending_user_decision":
      return "needs_decision";
    case "missing_successful_run_disposition":
      return "needs_disposition";
    case "owner_terminal":
      return "owner_terminal";
    case "blocked_chain_stalled":
      return "stalled";
    case "open_recovery_issue":
      return "recovery_required";
    case "external_owner_action":
      return "external_wait";
    case "blocked_by_uninvokable_assignee":
      return "owner_paused";
    default:
      return "needs_attention";
  }
}

export interface OwnerTerminalProjection {
  reason: "owner_terminal";
  terminalIssueId: string;
  terminalIdentifier: string | null;
  requiredOwnerAction: string;
  /** Must stay false: no Accept/Reject unless a real pending interaction exists. */
  hasPendingOwnerInteraction: boolean;
}

export function buildOwnerTerminalAttentionFields(input: {
  terminalIssueId: string;
  terminalIdentifier: string | null;
  requiredOwnerAction: string;
  hasPendingOwnerInteraction: boolean;
}): {
  reason: "owner_terminal";
  action: { label: string; detail: string };
  ownerType: "user" | "board";
} {
  return {
    reason: "owner_terminal",
    action: {
      label: "Owner terminal",
      detail:
        `Blocked on owner terminal ${input.terminalIdentifier ?? input.terminalIssueId}: `
        + `${input.requiredOwnerAction}`
        + (input.hasPendingOwnerInteraction
          ? " (pending interaction exists on terminal)"
          : " — not a Decide action on this parent; complete the terminal work first"),
    },
    ownerType: "user",
  };
}
