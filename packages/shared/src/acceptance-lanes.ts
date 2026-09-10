/**
 * Acceptance lanes + path-class scope for Decision/Gate System remediation.
 * Pure helpers — no I/O. Aligns with hub SR-DECISION-AND-GATE-SYSTEM-v1 and
 * registry/acceptance_lane_vocabulary.yaml.
 *
 * Fail-closed: runtime not_applicable requires a named standing policy OR an
 * explicit accepted structured decision matching artifact/head/lane/scope.
 * Merely "answered" interactions do not bind. Review and secret-scan are
 * non-waivable via N/A.
 */

export const ACCEPTANCE_LANE_STATES = [
  "pending",
  "satisfied",
  "failed",
  "blocked",
  "not_applicable",
  "superseded",
] as const;
export type AcceptanceLaneState = (typeof ACCEPTANCE_LANE_STATES)[number];

/**
 * Canonical path / artifact classes.
 * Hub schema uses longer names; Paperclip uses short aliases — map via
 * toCanonicalPathClass / fromCanonicalPathClass.
 */
export const PATH_CLASSES = [
  "documentation",
  "tests",
  "configuration",
  "executable",
  "deployment",
  "security_control",
  "generated",
  "mixed",
  "unknown",
] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

/** Hub decision_registry / acceptance_lane_state path_class enum. */
export const CANONICAL_PATH_CLASSES = [
  "documentation",
  "tests_evaluation",
  "configuration",
  "executable_runtime",
  "deployment_operations",
  "generated_or_security_sensitive",
  "program",
  "mixed",
] as const;
export type CanonicalPathClass = (typeof CANONICAL_PATH_CLASSES)[number];

const SHORT_TO_CANONICAL: Record<PathClass, CanonicalPathClass | "unknown"> = {
  documentation: "documentation",
  tests: "tests_evaluation",
  configuration: "configuration",
  executable: "executable_runtime",
  deployment: "deployment_operations",
  security_control: "generated_or_security_sensitive",
  generated: "generated_or_security_sensitive",
  mixed: "mixed",
  unknown: "unknown" as CanonicalPathClass | "unknown",
};

const CANONICAL_TO_SHORT: Record<string, PathClass> = {
  documentation: "documentation",
  tests_evaluation: "tests",
  configuration: "configuration",
  executable_runtime: "executable",
  deployment_operations: "deployment",
  generated_or_security_sensitive: "generated",
  program: "mixed",
  mixed: "mixed",
};

export function toCanonicalPathClass(pathClass: PathClass): string {
  return SHORT_TO_CANONICAL[pathClass] ?? "mixed";
}

export function fromCanonicalPathClass(canonical: string): PathClass {
  return CANONICAL_TO_SHORT[canonical] ?? "unknown";
}

export const DECISION_OWNERSHIP_CLASSES = [
  "deterministic",
  "standards_based",
  "evidence_based",
  "bounded_design",
  "reversible_implementation",
  "subjective_intent",
  "priority_tradeoff",
  "material_risk",
  "irreversible_external",
  "authority_change",
] as const;
export type DecisionOwnershipClass = (typeof DECISION_OWNERSHIP_CLASSES)[number];

export const AGENT_OWNERSHIP_CLASSES: ReadonlySet<DecisionOwnershipClass> = new Set([
  "deterministic",
  "standards_based",
  "evidence_based",
  "bounded_design",
  "reversible_implementation",
]);

export const HUMAN_OWNERSHIP_CLASSES: ReadonlySet<DecisionOwnershipClass> = new Set([
  "subjective_intent",
  "priority_tradeoff",
  "material_risk",
  "irreversible_external",
  "authority_change",
]);

/** Lanes that must never be set not_applicable (review/secret-scan non-waivable). */
export const NON_WAIVABLE_LANES = new Set([
  "independent_review",
  "exact_head_secret_scan",
  "review",
  "secret_scan",
]);

/** @deprecated Use NON_WAIVABLE_LANES */
export const NON_WAIVABLE_VIA_DOCS_NA = NON_WAIVABLE_LANES;

/**
 * Named standing policy that may authorize runtime N/A for documentation-only
 * artifacts without a fresh BA interaction. Generated artifacts are NOT covered.
 *
 * Policies are resolved only from this trusted in-code registry. A matching
 * string in ownerGuidance alone is never authority.
 */
export const STANDING_POLICY_DOCS_ONLY_RUNTIME_NA =
  "SR-DECISION-AND-GATE-SYSTEM-v1/docs-only-runtime-na" as const;

export interface StandingPolicyDefinition {
  id: string;
  /** Path classes this policy may authorize for runtime N/A. */
  allowedPathClasses: readonly PathClass[];
  /** When true, only runtime-family lanes may use this policy. */
  runtimeLanesOnly: boolean;
}

/** Trusted standing-policy registry — sole source of policy authority. */
export const TRUSTED_STANDING_POLICIES: Readonly<
  Record<string, StandingPolicyDefinition>
> = {
  [STANDING_POLICY_DOCS_ONLY_RUNTIME_NA]: {
    id: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
    allowedPathClasses: ["documentation"],
    runtimeLanesOnly: true,
  },
};

export function resolveTrustedStandingPolicy(
  policyId: string | null | undefined,
): StandingPolicyDefinition | null {
  if (!policyId) return null;
  return TRUSTED_STANDING_POLICIES[policyId] ?? null;
}

export const RUNTIME_LANE_KEYS = new Set([
  "runtime",
  "runtime_target_host",
  "target_host",
  "target_host_runtime",
]);

/** True when an option string is explicitly a runtime-N/A disposition. */
export function isRuntimeNaOption(option: string | null | undefined): boolean {
  if (!option) return false;
  const opt = option.toLowerCase().trim();
  if (opt === "runtime_not_applicable" || opt === "runtime_na" || opt === "runtime-n/a") {
    return true;
  }
  if (
    opt.includes("runtime")
    && (opt.includes("n/a") || opt.includes("not_applicable") || opt.includes("inapplicable") || opt.includes("not-applicable"))
  ) {
    return true;
  }
  // Historical PAP-3221 option id — only when coupled with runtime-family lane
  // (checked by caller). Bare acceptance_revision is NOT sufficient alone here;
  // callers must also verify RUNTIME_LANE_KEYS.
  if (opt === "acceptance_revision_runtime_na" || opt === "acceptance_revision:runtime_na") {
    return true;
  }
  return false;
}

/**
 * acceptance_revision is historically used for runtime-N/A on PAP-3221.
 * Allow only when the lane is runtime-family AND exact head (or decision id)
 * is present so it cannot waive arbitrary lanes.
 */
export function isScopedHistoricalAcceptanceRevisionOption(input: {
  option: string | null | undefined;
  laneKey: string;
  exactHead?: string | null;
  decisionId?: string | null;
}): boolean {
  const opt = String(input.option ?? "").toLowerCase().trim();
  if (opt !== "acceptance_revision") return false;
  if (!RUNTIME_LANE_KEYS.has(input.laneKey) && !input.laneKey.includes("runtime") && !input.laneKey.includes("target_host")) {
    return false;
  }
  // Require binding context so bare option cannot free-float.
  return Boolean(input.exactHead || input.decisionId);
}

export interface AcceptanceLaneRecord {
  state: AcceptanceLaneState;
  evidenceUri?: string | null;
  bindingInteractionId?: string | null;
  bindingDecisionId?: string | null;
  authority?: string | null;
  standingPolicyId?: string | null;
  updatedAt?: string | null;
  scope?: {
    pathClass?: PathClass;
    exactHead?: string | null;
    artifact?: string | null;
    issueId?: string | null;
  };
}

export type AcceptanceLaneMap = Record<string, AcceptanceLaneRecord>;

export function isAcceptanceLaneState(value: unknown): value is AcceptanceLaneState {
  return typeof value === "string" && (ACCEPTANCE_LANE_STATES as readonly string[]).includes(value);
}

export function isLaneControlling(state: AcceptanceLaneState): boolean {
  return state === "pending" || state === "failed" || state === "blocked";
}

/**
 * Classify changed paths into a single path class for scope inheritance.
 * Classification alone does NOT authorize runtime N/A.
 */
export function classifyChangedPaths(paths: string[]): PathClass {
  if (!paths.length) return "unknown";
  const classes = new Set<PathClass>();
  for (const raw of paths) {
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    // Generated/build outputs first — must not collapse to documentation via .md suffix.
    if (/(^|\/)(generated|dist|build|out|coverage)\//.test(p)) {
      classes.add("generated");
      continue;
    }
    if (
      p.startsWith("docs/")
      || p.endsWith(".md")
      || p.endsWith(".mdx")
      || p.endsWith(".rst")
      || /(^|\/)README(\.|$)/i.test(p)
    ) {
      classes.add("documentation");
      continue;
    }
    if (
      /(^|\/)(__tests__|tests?|e2e|fixtures)\//.test(p)
      || /\.(test|spec)\.[jt]sx?$/.test(p)
    ) {
      classes.add("tests");
      continue;
    }
    if (
      /(^|\/)(\.github\/workflows|deploy|Dockerfile)/.test(p)
      || /docker-compose/i.test(p)
    ) {
      classes.add("deployment");
      continue;
    }
    if (
      /(^|\/)(config|\.config)\//.test(p)
      || /\.(ya?ml|toml|env\.example)$/.test(p)
      || p.endsWith("package.json")
    ) {
      classes.add("configuration");
      continue;
    }
    if (/\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(p)) {
      classes.add("executable");
      continue;
    }
    classes.add("unknown");
  }
  if (classes.size === 1) return [...classes][0]!;
  if (classes.size > 1) return "mixed";
  return "unknown";
}

/**
 * Default runtime lane state by path class — ALWAYS pending (fail closed).
 * Path class alone never yields not_applicable.
 */
export function runtimeLaneDefaultForPathClass(_pathClass: PathClass): AcceptanceLaneState {
  return "pending";
}

export type StructuredDecisionResolutionStatus =
  | "accepted"
  | "approved"
  | "rejected"
  | "expired"
  | "superseded"
  | "answered"
  | "pending"
  | "cancelled";

/**
 * Explicit structured decision required to bind acceptance lanes.
 * "answered" alone is insufficient for not_applicable.
 */
export interface StructuredAcceptedDecision {
  interactionId: string;
  /** Interaction or decision resolution status. */
  resolutionStatus: StructuredDecisionResolutionStatus;
  /** Decision registry status when known. */
  decisionStatus?: "proposed" | "approved" | "superseded" | "expired" | "rejected" | null;
  laneKey: string;
  option?: string | null;
  exactHead?: string | null;
  artifactRef?: string | null;
  issueId?: string | null;
  pathClass?: PathClass | null;
  expiresAt?: string | null;
  resolvedAt?: string | null;
  decisionId?: string | null;
  authorityActor?: "agent" | "ba" | "board" | "system" | null;
}

export interface RuntimeNaEligibilityInput {
  laneKey: string;
  pathClass?: PathClass | null;
  /** Named standing policy id, if claiming policy path A. */
  standingPolicyId?: string | null;
  /** Explicit accepted structured decision, if claiming path B. */
  decision?: StructuredAcceptedDecision | null;
  /** Expected closeout context that the decision must match. */
  expected?: {
    exactHead?: string | null;
    artifactRef?: string | null;
    issueId?: string | null;
    laneKey?: string | null;
  };
  nowIso?: string;
}

export type RuntimeNaEligibilityCode =
  | "ok_standing_policy"
  | "ok_accepted_decision"
  | "refused_non_waivable_lane"
  | "refused_no_authority"
  | "refused_path_only"
  | "refused_generated_default"
  | "refused_unrecognized_policy"
  | "refused_decision_not_accepted"
  | "refused_decision_rejected"
  | "refused_decision_expired"
  | "refused_decision_superseded"
  | "refused_lane_mismatch"
  | "refused_exact_head_mismatch"
  | "refused_artifact_mismatch"
  | "refused_issue_mismatch"
  | "refused_unrelated_option";

export interface RuntimeNaEligibilityResult {
  eligible: boolean;
  code: RuntimeNaEligibilityCode;
  message: string;
  authority: string | null;
}

function isExpired(expiresAt: string | null | undefined, nowIso: string): boolean {
  if (!expiresAt) return false;
  const exp = Date.parse(expiresAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(exp) || Number.isNaN(now)) return false;
  return exp <= now;
}

/** Git short-SHA floor: refuse 1–6 char prefixes that over-match full heads. */
export const MIN_EXACT_HEAD_PREFIX_LEN = 7;

export function isUsableExactHead(head: string | null | undefined): boolean {
  if (!head) return false;
  const h = head.trim().toLowerCase();
  if (h.length < MIN_EXACT_HEAD_PREFIX_LEN) return false;
  return /^[0-9a-f]+$/.test(h);
}

/**
 * Exact-head equality with controlled prefix matching.
 * Both sides must be hex and at least MIN_EXACT_HEAD_PREFIX_LEN for prefix match.
 */
export function exactHeadsMatch(
  decisionHead: string | null | undefined,
  expectedHead: string | null | undefined,
): boolean {
  if (!decisionHead || !expectedHead) return false;
  const a = decisionHead.trim().toLowerCase();
  const b = expectedHead.trim().toLowerCase();
  if (a === b) return true;
  if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  if (a.length < MIN_EXACT_HEAD_PREFIX_LEN || b.length < MIN_EXACT_HEAD_PREFIX_LEN) {
    return false;
  }
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Fail-closed gate for runtime not_applicable.
 * Path A: named standing policy + documentation path class.
 * Path B: explicit accepted/approved structured decision with scope match.
 */
export function evaluateRuntimeNaEligibility(
  input: RuntimeNaEligibilityInput,
): RuntimeNaEligibilityResult {
  const laneKey = input.laneKey;
  if (NON_WAIVABLE_LANES.has(laneKey)) {
    return {
      eligible: false,
      code: "refused_non_waivable_lane",
      message: `lane ${laneKey} cannot be not_applicable`,
      authority: null,
    };
  }

  const pathClass = input.pathClass ?? null;
  const decision = input.decision ?? null;
  const expected = input.expected ?? {};
  const nowIso = input.nowIso ?? new Date().toISOString();

  // Path A — standing policy from trusted registry only (never caller-invented).
  if (input.standingPolicyId) {
    const policy = resolveTrustedStandingPolicy(input.standingPolicyId);
    if (!policy) {
      return {
        eligible: false,
        code: "refused_unrecognized_policy",
        message: `unrecognized standing policy: ${input.standingPolicyId}`,
        authority: null,
      };
    }
    if (pathClass === "generated") {
      return {
        eligible: false,
        code: "refused_generated_default",
        message: "generated path class is not authorized for runtime N/A by default",
        authority: null,
      };
    }
    if (!pathClass || !policy.allowedPathClasses.includes(pathClass)) {
      return {
        eligible: false,
        code: "refused_path_only",
        message: `standing policy ${policy.id} requires path class in [${policy.allowedPathClasses.join(", ")}] from trusted closeout target (got ${pathClass ?? "null"})`,
        authority: null,
      };
    }
    if (policy.runtimeLanesOnly) {
      if (!RUNTIME_LANE_KEYS.has(laneKey) && !laneKey.includes("runtime") && !laneKey.includes("target_host")) {
        return {
          eligible: false,
          code: "refused_lane_mismatch",
          message: `standing policy does not authorize N/A for lane ${laneKey}`,
          authority: null,
        };
      }
    }
    return {
      eligible: true,
      code: "ok_standing_policy",
      message: `authorized by trusted standing policy ${policy.id}`,
      authority: policy.id,
    };
  }

  // Path B — explicit accepted structured decision.
  if (decision) {
    const res = decision.resolutionStatus;
    const dStat = decision.decisionStatus ?? null;

    if (res === "rejected" || dStat === "rejected") {
      return {
        eligible: false,
        code: "refused_decision_rejected",
        message: "rejected decision cannot bind runtime N/A",
        authority: null,
      };
    }
    if (res === "expired" || dStat === "expired" || isExpired(decision.expiresAt, nowIso)) {
      return {
        eligible: false,
        code: "refused_decision_expired",
        message: "expired decision cannot bind runtime N/A",
        authority: null,
      };
    }
    if (res === "superseded" || dStat === "superseded") {
      return {
        eligible: false,
        code: "refused_decision_superseded",
        message: "superseded decision cannot bind runtime N/A",
        authority: null,
      };
    }
    // Merely "answered" is insufficient — must be accepted/approved.
    if (res !== "accepted" && res !== "approved" && dStat !== "approved") {
      return {
        eligible: false,
        code: "refused_decision_not_accepted",
        message:
          `decision resolutionStatus=${res} is insufficient; require accepted/approved (not merely answered)`,
        authority: null,
      };
    }

    const expectedLane = expected.laneKey ?? laneKey;
    if (decision.laneKey !== expectedLane && decision.laneKey !== laneKey) {
      return {
        eligible: false,
        code: "refused_lane_mismatch",
        message: `decision lane ${decision.laneKey} does not match ${laneKey}`,
        authority: null,
      };
    }

    // Fail-closed head binding: decision must carry a usable exactHead, and
    // when expected supplies one they must match under strict short-SHA rules.
    if (!decision.exactHead || !String(decision.exactHead).trim()) {
      return {
        eligible: false,
        code: "refused_exact_head_mismatch",
        message:
          "accepted runtime N/A decision must bind an exactHead (unscoped decisions refused)",
        authority: null,
      };
    }
    if (expected.exactHead) {
      if (!exactHeadsMatch(decision.exactHead, expected.exactHead)) {
        return {
          eligible: false,
          code: "refused_exact_head_mismatch",
          message: `exact head mismatch decision=${decision.exactHead} expected=${expected.exactHead}`,
          authority: null,
        };
      }
    } else if (!isUsableExactHead(decision.exactHead)) {
      return {
        eligible: false,
        code: "refused_exact_head_mismatch",
        message: `decision exactHead too short or non-hex for free-standing bind: ${decision.exactHead}`,
        authority: null,
      };
    }

    if (expected.artifactRef) {
      if (!decision.artifactRef) {
        return {
          eligible: false,
          code: "refused_artifact_mismatch",
          message: "decision missing artifactRef while closeout requires one",
          authority: null,
        };
      }
      if (decision.artifactRef !== expected.artifactRef) {
        return {
          eligible: false,
          code: "refused_artifact_mismatch",
          message: `artifact mismatch decision=${decision.artifactRef} expected=${expected.artifactRef}`,
          authority: null,
        };
      }
    }
    if (expected.issueId) {
      if (!decision.issueId) {
        return {
          eligible: false,
          code: "refused_issue_mismatch",
          message: "decision missing issueId while closeout requires one",
          authority: null,
        };
      }
      if (decision.issueId !== expected.issueId) {
        return {
          eligible: false,
          code: "refused_issue_mismatch",
          message: `issue mismatch decision=${decision.issueId} expected=${expected.issueId}`,
          authority: null,
        };
      }
    }

    // Option must declare runtime-N/A intent. Bare acceptance_revision is not
    // enough unless scoped to a runtime-family lane with head/decision id.
    if (!decision.option) {
      return {
        eligible: false,
        code: "refused_unrelated_option",
        message: "accepted decision missing runtime-N/A option",
        authority: null,
      };
    }
    {
      const runtimeNa =
        isRuntimeNaOption(decision.option)
        || isScopedHistoricalAcceptanceRevisionOption({
          option: decision.option,
          laneKey: decision.laneKey,
          exactHead: decision.exactHead,
          decisionId: decision.decisionId,
        });
      if (!runtimeNa) {
        return {
          eligible: false,
          code: "refused_unrelated_option",
          message: `option ${decision.option} is unrelated to runtime N/A (acceptance_revision requires runtime lane + exactHead or decisionId)`,
          authority: null,
        };
      }
    }

    return {
      eligible: true,
      code: "ok_accepted_decision",
      message: "authorized by accepted structured decision",
      authority: `interaction:${decision.interactionId}`,
    };
  }

  // No policy, no decision — path class alone is never enough.
  if (pathClass === "documentation" || pathClass === "generated") {
    return {
      eligible: false,
      code: pathClass === "generated" ? "refused_generated_default" : "refused_path_only",
      message:
        pathClass === "generated"
          ? "generated path class does not authorize runtime N/A"
          : "documentation path class alone does not authorize runtime N/A without standing policy or accepted decision",
      authority: null,
    };
  }

  return {
    eligible: false,
    code: "refused_no_authority",
    message: "runtime N/A requires standing policy or accepted structured decision",
    authority: null,
  };
}

export interface BindAnsweredInteractionInput {
  lanes: AcceptanceLaneMap;
  laneKey: string;
  state: AcceptanceLaneState;
  interactionId: string;
  authority?: string;
  evidenceUri?: string | null;
  scope?: AcceptanceLaneRecord["scope"];
  updatedAt?: string;
  /**
   * @deprecated Ignored. Non-waivable lanes always refuse not_applicable.
   * Kept for call-site compatibility only.
   */
  protectNonWaivable?: boolean;
  /**
   * For state=not_applicable on runtime-family lanes, eligibility is required.
   * Omit only when state is not not_applicable.
   */
  runtimeNa?: Omit<RuntimeNaEligibilityInput, "laneKey"> | null;
  bindingDecisionId?: string | null;
  /**
   * When binding not_applicable, resolution must be accepted/approved unless
   * standing policy path is used via runtimeNa.standingPolicyId.
   */
  resolutionStatus?: StructuredDecisionResolutionStatus;
}

export interface BindAnsweredInteractionResult {
  lanes: AcceptanceLaneMap;
  applied: boolean;
  code:
    | "ok"
    | "refused_non_waivable"
    | "invalid_state"
    | "refused_runtime_na"
    | RuntimeNaEligibilityCode;
  message: string | null;
}

/**
 * Bind an owner decision onto a named acceptance lane.
 * Pure: returns a new map. Fail-closed for runtime N/A.
 */
export function bindAnsweredInteractionToLane(
  input: BindAnsweredInteractionInput,
): BindAnsweredInteractionResult {
  if (!isAcceptanceLaneState(input.state)) {
    return {
      lanes: input.lanes,
      applied: false,
      code: "invalid_state",
      message: `invalid acceptance lane state: ${String(input.state)}`,
    };
  }
  // Non-waivable lanes are always protected — protectNonWaivable cannot disable this.
  if (input.state === "not_applicable" && NON_WAIVABLE_LANES.has(input.laneKey)) {
    return {
      lanes: input.lanes,
      applied: false,
      code: "refused_non_waivable",
      message:
        `lane ${input.laneKey} cannot be set not_applicable (review/secret-scan non-waivable)`,
    };
  }

  if (input.state === "not_applicable") {
    const isRuntimeFamily =
      RUNTIME_LANE_KEYS.has(input.laneKey)
      || input.laneKey.includes("runtime")
      || input.laneKey.includes("target_host");

    if (isRuntimeFamily) {
      const decisionFromInput: StructuredAcceptedDecision | null = input.runtimeNa?.decision
        ?? (input.interactionId
          ? {
              interactionId: input.interactionId,
              resolutionStatus: input.resolutionStatus ?? "answered",
              laneKey: input.laneKey,
              exactHead: input.scope?.exactHead ?? null,
              artifactRef: input.scope?.artifact ?? null,
              issueId: input.scope?.issueId ?? null,
              pathClass: input.scope?.pathClass ?? null,
              decisionId: input.bindingDecisionId ?? null,
            }
          : null);

      const eligibility = evaluateRuntimeNaEligibility({
        laneKey: input.laneKey,
        pathClass: input.runtimeNa?.pathClass ?? input.scope?.pathClass ?? null,
        standingPolicyId: input.runtimeNa?.standingPolicyId ?? null,
        decision: input.runtimeNa?.standingPolicyId ? null : decisionFromInput,
        expected: input.runtimeNa?.expected ?? {
          exactHead: input.scope?.exactHead ?? null,
          artifactRef: input.scope?.artifact ?? null,
          issueId: input.scope?.issueId ?? null,
          laneKey: input.laneKey,
        },
        nowIso: input.runtimeNa?.nowIso,
      });

      if (!eligibility.eligible) {
        return {
          lanes: input.lanes,
          applied: false,
          code: eligibility.code,
          message: eligibility.message,
        };
      }

      const next: AcceptanceLaneMap = {
        ...input.lanes,
        [input.laneKey]: {
          state: "not_applicable",
          bindingInteractionId: input.interactionId,
          bindingDecisionId: input.bindingDecisionId ?? null,
          authority: eligibility.authority ?? input.authority ?? "accepted_decision",
          standingPolicyId: input.runtimeNa?.standingPolicyId ?? null,
          evidenceUri: input.evidenceUri ?? null,
          scope: input.scope,
          updatedAt: input.updatedAt ?? new Date().toISOString(),
        },
      };
      // Ensure non-waivable siblings remain pending if present.
      for (const sib of ["independent_review", "exact_head_secret_scan", "review", "secret_scan"]) {
        if (next[sib]?.state === "not_applicable") {
          next[sib] = { ...next[sib]!, state: "pending" };
        }
      }
      return { lanes: next, applied: true, code: "ok", message: null };
    }
  }

  const next: AcceptanceLaneMap = {
    ...input.lanes,
    [input.laneKey]: {
      state: input.state,
      bindingInteractionId: input.interactionId,
      bindingDecisionId: input.bindingDecisionId ?? null,
      authority: input.authority ?? "answered_interaction",
      evidenceUri: input.evidenceUri ?? null,
      scope: input.scope,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    },
  };
  return { lanes: next, applied: true, code: "ok", message: null };
}

/**
 * Truth precedence helper (pure): structured lane state wins over fallback prose.
 * Callers must supply the newest valid binding; this does not parse comments.
 */
export function resolveLaneEffectiveState(
  lane: AcceptanceLaneRecord | undefined,
  fallback: AcceptanceLaneState = "pending",
): AcceptanceLaneState {
  if (!lane) return fallback;
  return lane.state;
}

export function isAgentOwnershipClass(c: DecisionOwnershipClass): boolean {
  return AGENT_OWNERSHIP_CLASSES.has(c);
}

export function isHumanOwnershipClass(c: DecisionOwnershipClass): boolean {
  return HUMAN_OWNERSHIP_CLASSES.has(c);
}

/** Blocker statuses that must not control dependents (pure helper; Phase 3 wires service). */
export const SATISFIED_BLOCKER_STATUSES = [
  "done",
  "cancelled",
  "canceled",
  "superseded",
] as const;

export function isSatisfiedBlockerStatus(status: string): boolean {
  const s = status.toLowerCase();
  return (SATISFIED_BLOCKER_STATUSES as readonly string[]).includes(s);
}

/**
 * Pure filter of blockedBy ids to those still controlling given status map.
 * Not integrated into issue service in foundation PR #150 — reserved for Phase 3.
 */
export function filterControllingBlockerIds(
  blockedByIssueIds: string[],
  statusById: Record<string, string>,
): { controlling: string[]; satisfied: string[] } {
  const controlling: string[] = [];
  const satisfied: string[] = [];
  for (const id of blockedByIssueIds) {
    const st = statusById[id];
    if (st && isSatisfiedBlockerStatus(st)) satisfied.push(id);
    else controlling.push(id);
  }
  return { controlling, satisfied };
}

/**
 * Missing-disposition attention eligibility (single implementation).
 * Live execution statuses only: in_progress and in_review.
 * backlog/todo/blocked/done are Agent Ops ledger candidates, not BA inbox spam —
 * but in_review with a successful-run handoff still needs disposition visibility
 * on the Agent Ops surface (and may appear in blocked attention when eligible).
 */
export const MISSING_DISPOSITION_ELIGIBLE_STATUSES = [
  "in_progress",
  "in_review",
] as const;

export function shouldSurfaceMissingDisposition(issueStatus: string): boolean {
  return (MISSING_DISPOSITION_ELIGIBLE_STATUSES as readonly string[]).includes(issueStatus);
}

/** Agent Ops surface classification for disposition debt (not Human Decisions). */
export type AgentOpsObjectClass =
  | "missing_disposition"
  | "liveness_twin"
  | "empty_blocker_debt"
  | "other_agent_ops";

export interface AgentOpsDispositionDebtItem {
  objectClass: "missing_disposition";
  issueId: string;
  issueIdentifier: string | null;
  issueStatus: string;
  companyId: string;
  reason: "missing_successful_run_disposition";
  /** ISO timestamp when the successful run / handoff stopped without disposition. */
  stoppedSinceAt: string | null;
  ageMs: number | null;
  sourceRunId: string | null;
  assigneeAgentId: string | null;
  requiredNextDisposition:
    | "done"
    | "cancelled"
    | "review_or_input"
    | "blocked_with_owner"
    | "delegated_follow_up"
    | "queued_continuation";
  inHumanDecisionsLane: false;
  inAgentOpsLane: true;
}

export interface BuildAgentOpsDispositionDebtInput {
  issueId: string;
  issueIdentifier?: string | null;
  issueStatus: string;
  companyId: string;
  stoppedSinceAt?: string | null;
  sourceRunId?: string | null;
  assigneeAgentId?: string | null;
  nowMs?: number;
}

/**
 * Build a stable Agent Ops disposition debt row for reconciler/query surfaces.
 * Always excludes Human Decisions lane.
 */
export function buildAgentOpsDispositionDebtItem(
  input: BuildAgentOpsDispositionDebtInput,
): AgentOpsDispositionDebtItem {
  const now = input.nowMs ?? Date.now();
  let ageMs: number | null = null;
  if (input.stoppedSinceAt) {
    const t = Date.parse(input.stoppedSinceAt);
    if (!Number.isNaN(t)) ageMs = Math.max(0, now - t);
  }
  return {
    objectClass: "missing_disposition",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier ?? null,
    issueStatus: input.issueStatus,
    companyId: input.companyId,
    reason: "missing_successful_run_disposition",
    stoppedSinceAt: input.stoppedSinceAt ?? null,
    ageMs,
    sourceRunId: input.sourceRunId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    requiredNextDisposition: "done",
    inHumanDecisionsLane: false,
    inAgentOpsLane: true,
  };
}

export interface AgentOpsDispositionDebtSummary {
  count: number;
  items: AgentOpsDispositionDebtItem[];
  oldestAgeMs: number | null;
}

export function summarizeAgentOpsDispositionDebt(
  items: AgentOpsDispositionDebtItem[],
): AgentOpsDispositionDebtSummary {
  let oldestAgeMs: number | null = null;
  for (const it of items) {
    if (it.ageMs == null) continue;
    if (oldestAgeMs == null || it.ageMs > oldestAgeMs) oldestAgeMs = it.ageMs;
  }
  return { count: items.length, items, oldestAgeMs };
}
