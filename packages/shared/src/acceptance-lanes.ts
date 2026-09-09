/**
 * Acceptance lanes + path-class scope for Decision/Gate System remediation.
 * Pure helpers — no I/O. Aligns with hub SR-DECISION-AND-GATE-SYSTEM-v1 and
 * registry/acceptance_lane_vocabulary.yaml.
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

/** Lanes that must never be waived solely via not_applicable on docs-only path class. */
export const NON_WAIVABLE_VIA_DOCS_NA = new Set([
  "independent_review",
  "exact_head_secret_scan",
]);

export interface AcceptanceLaneRecord {
  state: AcceptanceLaneState;
  evidenceUri?: string | null;
  bindingInteractionId?: string | null;
  authority?: string | null;
  updatedAt?: string | null;
  scope?: {
    pathClass?: PathClass;
    exactHead?: string | null;
    artifact?: string | null;
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
 * Documentation-only → documentation (runtime N/A eligible).
 */
export function classifyChangedPaths(paths: string[]): PathClass {
  if (!paths.length) return "unknown";
  const classes = new Set<PathClass>();
  for (const raw of paths) {
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
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
    if (/(^|\/)(generated|dist|build)\//.test(p)) {
      classes.add("generated");
      continue;
    }
    classes.add("unknown");
  }
  if (classes.size === 1) return [...classes][0]!;
  if (classes.size > 1) return "mixed";
  return "unknown";
}

/**
 * Whether runtime/target-host verification is not_applicable for this path class.
 * Does NOT waive review or secret-scan.
 */
export function runtimeLaneDefaultForPathClass(pathClass: PathClass): AcceptanceLaneState {
  if (pathClass === "documentation") return "not_applicable";
  if (pathClass === "generated") return "not_applicable";
  return "pending";
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
  /** When true, refuse not_applicable on non-waivable lanes. */
  protectNonWaivable?: boolean;
}

export interface BindAnsweredInteractionResult {
  lanes: AcceptanceLaneMap;
  applied: boolean;
  code: "ok" | "refused_non_waivable" | "invalid_state";
  message: string | null;
}

/**
 * Bind an answered owner interaction onto a named acceptance lane.
 * Pure: returns a new map.
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
  if (
    input.protectNonWaivable !== false
    && input.state === "not_applicable"
    && NON_WAIVABLE_VIA_DOCS_NA.has(input.laneKey)
  ) {
    return {
      lanes: input.lanes,
      applied: false,
      code: "refused_non_waivable",
      message:
        `lane ${input.laneKey} cannot be set not_applicable (review/secret-scan non-waivable)`,
    };
  }
  const next: AcceptanceLaneMap = {
    ...input.lanes,
    [input.laneKey]: {
      state: input.state,
      bindingInteractionId: input.interactionId,
      authority: input.authority ?? "answered_interaction",
      evidenceUri: input.evidenceUri ?? null,
      scope: input.scope,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    },
  };
  return { lanes: next, applied: true, code: "ok", message: null };
}

/**
 * Truth precedence: answered interaction binding wins over stale required prose.
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

/** Blocker statuses that must not control dependents. */
export const SATISFIED_BLOCKER_STATUSES = [
  "done",
  "cancelled",
  "superseded",
] as const;

export function isSatisfiedBlockerStatus(status: string): boolean {
  const s = status.toLowerCase();
  return (SATISFIED_BLOCKER_STATUSES as readonly string[]).includes(s) || s === "done";
}

/**
 * Filter blockedBy ids to those still controlling given status map.
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
 * Disposition attention should only apply while work is actively in_progress.
 * backlog/todo/done/cancelled/in_review without live run are agent-ops reconcile, not inbox spam.
 */
export function shouldSurfaceMissingDisposition(issueStatus: string): boolean {
  return issueStatus === "in_progress";
}
