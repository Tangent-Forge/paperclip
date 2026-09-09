/**
 * Acceptance-lane closeout helpers (decision/gate remediation).
 *
 * Pure functions: bind answered interactions into lane state, classify path
 * scope, and keep runtime not_applicable from waiving review/secret_scan.
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

export const ARTIFACT_PATH_CLASSES = [
  "documentation",
  "tests_evaluation",
  "configuration",
  "executable_runtime",
  "deployment_operations",
  "generated_or_security_sensitive",
  "program",
  "mixed",
] as const;
export type ArtifactPathClass = (typeof ARTIFACT_PATH_CLASSES)[number];

export type CloseoutLane = {
  laneId: string;
  state: AcceptanceLaneState;
  bindingInteractionId?: string | null;
  evidenceRefs?: string[];
  doesNotWaive?: string[];
  notes?: string;
};

export type CloseoutInteraction = {
  id: string;
  status: string;
  summary?: string | null;
  optionHint?: string | null;
};

export function classifyChangedPaths(paths: string[]): ArtifactPathClass {
  if (!paths.length) return "mixed";
  const docsOnly = paths.every(
    (p) => p.startsWith("docs/") || p.endsWith(".md") || p.includes("/docs/"),
  );
  return docsOnly ? "documentation" : "mixed";
}

/**
 * Bind runtime lane to not_applicable for docs-only / answered acceptance_revision.
 * Never marks review or secret_scan as N/A.
 */
export function applyAnsweredRuntimeNotApplicable(
  lanes: Record<string, CloseoutLane>,
  input: {
    interaction: CloseoutInteraction;
    pathClass: ArtifactPathClass;
  },
): Record<string, CloseoutLane> {
  const next: Record<string, CloseoutLane> = { ...lanes };
  const { interaction, pathClass } = input;
  if (interaction.status !== "answered" && interaction.status !== "accepted") {
    return next;
  }
  const summary = `${interaction.summary ?? ""} ${interaction.optionHint ?? ""}`.toLowerCase();
  const isRuntimeRevision =
    summary.includes("acceptance_revision")
    || (
      summary.includes("runtime")
      && (summary.includes("n/a")
        || summary.includes("not_applicable")
        || summary.includes("inapplicable"))
    )
    || interaction.optionHint === "acceptance_revision";

  if (!isRuntimeRevision && pathClass !== "documentation") {
    return next;
  }
  if (pathClass !== "documentation" && !isRuntimeRevision) {
    return next;
  }

  const runtime: CloseoutLane = {
    ...(next.runtime ?? { laneId: "runtime", state: "pending" }),
    laneId: "runtime",
    state: "not_applicable",
    bindingInteractionId: interaction.id,
    evidenceRefs: Array.from(
      new Set([...(next.runtime?.evidenceRefs ?? []), `interaction:${interaction.id}`]),
    ),
    doesNotWaive: ["review", "secret_scan"],
    notes: "runtime not_applicable for docs-only / answered acceptance_revision",
  };
  next.runtime = runtime;

  for (const sib of ["review", "secret_scan"] as const) {
    const existing = next[sib];
    if (!existing) {
      next[sib] = { laneId: sib, state: "pending" };
    } else if (existing.state === "not_applicable") {
      next[sib] = {
        ...existing,
        state: "pending",
        notes: `restored pending; runtime N/A must not waive ${sib}`,
      };
    }
  }
  return next;
}

export type BlockerEdge = { id: string; status: string };

/** done/cancelled/superseded edges are non-controlling. */
export function partitionBlockerEdges(edges: BlockerEdge[]): {
  controlling: BlockerEdge[];
  cleared: BlockerEdge[];
} {
  const controlling: BlockerEdge[] = [];
  const cleared: BlockerEdge[] = [];
  for (const edge of edges) {
    const st = (edge.status || "").toLowerCase();
    if (st === "done" || st === "cancelled" || st === "canceled" || st === "superseded") {
      cleared.push(edge);
    } else {
      controlling.push(edge);
    }
  }
  return { controlling, cleared };
}

/** Human Decisions count excludes disposition agent-ops. */
export function countHumanDecisionAttentions(
  attentions: Array<{ reason?: string | null }>,
): number {
  let n = 0;
  for (const a of attentions) {
    const reason = a.reason ?? "";
    if (reason === "missing_successful_run_disposition") continue;
    if (
      reason === "pending_board_decision"
      || reason === "pending_user_decision"
      || reason === "external_owner_action"
    ) {
      n += 1;
    }
  }
  return n;
}
