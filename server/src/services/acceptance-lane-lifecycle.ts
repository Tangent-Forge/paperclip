/**
 * Phase 3 — Decision/Gate lifecycle integration.
 * Authoritative lane state is derived/persisted on issue.executionState.acceptanceLanes.
 * Fail-closed runtime N/A uses shared acceptance-lanes helpers.
 */
import type { Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { issues, issueRelations } from "@paperclipai/db";
import {
  type AcceptanceLaneMap,
  type AcceptanceLaneState,
  type StructuredAcceptedDecision,
  bindAnsweredInteractionToLane,
  evaluateRuntimeNaEligibility,
  filterControllingBlockerIds,
  isSatisfiedBlockerStatus,
  shouldSurfaceMissingDisposition,
  STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
} from "@paperclipai/shared";

export const ACCEPTANCE_LANES_STATE_KEY = "acceptanceLanes" as const;

export type EvidencePrecedenceSource =
  | "accepted_interaction"
  | "structured_evidence"
  | "comment"
  | "cached_blocker_summary";

export interface LaneBindingRequest {
  companyId: string;
  issueId: string;
  laneKey: string;
  state: AcceptanceLaneState;
  interactionId: string;
  resolutionStatus: StructuredAcceptedDecision["resolutionStatus"];
  option?: string | null;
  exactHead?: string | null;
  artifactRef?: string | null;
  pathClass?: StructuredAcceptedDecision["pathClass"];
  standingPolicyId?: string | null;
  decisionId?: string | null;
  expiresAt?: string | null;
  evidenceUri?: string | null;
  updatedAt?: string;
}

export interface LaneBindingResult {
  applied: boolean;
  code: string;
  message: string | null;
  lanes: AcceptanceLaneMap;
  issueId: string;
}

export function readAcceptanceLanesFromExecutionState(
  executionState: Record<string, unknown> | null | undefined,
): AcceptanceLaneMap {
  if (!executionState || typeof executionState !== "object") return {};
  const raw = executionState[ACCEPTANCE_LANES_STATE_KEY];
  if (!raw || typeof raw !== "object") return {};
  return { ...(raw as AcceptanceLaneMap) };
}

export function writeAcceptanceLanesIntoExecutionState(
  executionState: Record<string, unknown> | null | undefined,
  lanes: AcceptanceLaneMap,
): Record<string, unknown> {
  const base = executionState && typeof executionState === "object" ? { ...executionState } : {};
  base[ACCEPTANCE_LANES_STATE_KEY] = lanes;
  base.acceptanceLanesUpdatedAt = new Date().toISOString();
  return base;
}

/**
 * Evidence precedence rank (higher wins). Stale comments must not override
 * accepted structured lane bindings.
 */
export function evidencePrecedenceRank(source: EvidencePrecedenceSource): number {
  switch (source) {
    case "accepted_interaction":
      return 40;
    case "structured_evidence":
      return 30;
    case "comment":
      return 20;
    case "cached_blocker_summary":
      return 10;
    default:
      return 0;
  }
}

export function preferEvidenceSource(
  newer: EvidencePrecedenceSource,
  older: EvidencePrecedenceSource,
): EvidencePrecedenceSource {
  return evidencePrecedenceRank(newer) >= evidencePrecedenceRank(older) ? newer : older;
}

/**
 * Idempotent pure bind: same accepted interaction + same lane/state is a no-op apply.
 */
export function bindLaneTransitionIdempotent(
  current: AcceptanceLaneMap,
  request: LaneBindingRequest,
): LaneBindingResult {
  const existing = current[request.laneKey];
  if (
    existing
    && existing.state === request.state
    && existing.bindingInteractionId === request.interactionId
  ) {
    return {
      applied: true,
      code: "ok_idempotent",
      message: null,
      lanes: current,
      issueId: request.issueId,
    };
  }

  const decision: StructuredAcceptedDecision = {
    interactionId: request.interactionId,
    resolutionStatus: request.resolutionStatus,
    laneKey: request.laneKey,
    option: request.option ?? null,
    exactHead: request.exactHead ?? null,
    artifactRef: request.artifactRef ?? null,
    issueId: request.issueId,
    pathClass: request.pathClass ?? null,
    expiresAt: request.expiresAt ?? null,
    decisionId: request.decisionId ?? null,
  };

  const result = bindAnsweredInteractionToLane({
    lanes: current,
    laneKey: request.laneKey,
    state: request.state,
    interactionId: request.interactionId,
    resolutionStatus: request.resolutionStatus,
    bindingDecisionId: request.decisionId ?? null,
    evidenceUri: request.evidenceUri ?? null,
    updatedAt: request.updatedAt,
    scope: {
      pathClass: request.pathClass ?? undefined,
      exactHead: request.exactHead ?? null,
      artifact: request.artifactRef ?? null,
      issueId: request.issueId,
    },
    runtimeNa:
      request.state === "not_applicable"
        ? {
            pathClass: request.pathClass ?? null,
            standingPolicyId: request.standingPolicyId ?? null,
            decision: request.standingPolicyId ? null : decision,
            expected: {
              exactHead: request.exactHead ?? null,
              artifactRef: request.artifactRef ?? null,
              issueId: request.issueId,
              laneKey: request.laneKey,
            },
          }
        : null,
  });

  return {
    applied: result.applied,
    code: result.code,
    message: result.message,
    lanes: result.lanes,
    issueId: request.issueId,
  };
}

export function createAcceptanceLaneService(db: Db) {
  async function loadIssue(companyId: string, issueId: string) {
    const rows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        executionState: issues.executionState,
        parentId: issues.parentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function persistLanes(
    companyId: string,
    issueId: string,
    executionState: Record<string, unknown> | null | undefined,
    lanes: AcceptanceLaneMap,
  ) {
    const nextState = writeAcceptanceLanesIntoExecutionState(executionState, lanes);
    await db
      .update(issues)
      .set({
        executionState: nextState,
        updatedAt: new Date(),
      })
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    return nextState;
  }

  return {
    /**
     * Bind an accepted interaction result onto structured acceptance lanes.
     * Idempotent. Does not wake agents.
     */
    applyAcceptedInteractionBinding: async (request: LaneBindingRequest): Promise<LaneBindingResult> => {
      const issue = await loadIssue(request.companyId, request.issueId);
      if (!issue) {
        return {
          applied: false,
          code: "issue_not_found",
          message: `issue ${request.issueId} not found`,
          lanes: {},
          issueId: request.issueId,
        };
      }
      const current = readAcceptanceLanesFromExecutionState(
        issue.executionState as Record<string, unknown> | null,
      );
      const bound = bindLaneTransitionIdempotent(current, request);
      if (!bound.applied) return bound;
      if (bound.code === "ok_idempotent") return bound;
      await persistLanes(
        request.companyId,
        request.issueId,
        issue.executionState as Record<string, unknown> | null,
        bound.lanes,
      );
      return bound;
    },

    /**
     * Recalculate controlling blockedBy edges for an issue (done/cancelled/superseded non-controlling).
     * Historical relations remain in DB; only the controlling set is returned.
     */
    listControllingBlockers: async (companyId: string, issueId: string) => {
      const rels = await db
        .select({
          blockerIssueId: issueRelations.issueId,
        })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ));
      const blockerIds = (rels as Array<{ blockerIssueId: string }>).map((r) => r.blockerIssueId);
      if (blockerIds.length === 0) {
        return { controlling: [] as string[], satisfied: [] as string[], statusById: {} as Record<string, string> };
      }
      const statusRows = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIds)));
      const statusById: Record<string, string> = {};
      for (const row of statusRows as Array<{ id: string; status: string }>) {
        statusById[row.id] = row.status;
      }
      const filtered = filterControllingBlockerIds(blockerIds, statusById);
      return { ...filtered, statusById };
    },

    /**
     * Parent gate recalculation: when a child lane becomes satisfied/N/A,
     * recompute whether parent still has controlling blockers.
     * Does not mass-wake; returns next executable leaf eligibility only.
     */
    recalculateParentGate: async (companyId: string, childIssueId: string) => {
      const child = await loadIssue(companyId, childIssueId);
      if (!child?.parentId) {
        return { parentId: null as string | null, controllingBlockers: [] as string[], childEligible: false };
      }
      const parentControl = await (async () => {
        const rels = await db
          .select({
            blockerIssueId: issueRelations.issueId,
          })
          .from(issueRelations)
          .where(and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.relatedIssueId, child.parentId!),
            eq(issueRelations.type, "blocks"),
          ));
        const blockerIds = (rels as Array<{ blockerIssueId: string }>).map((r) => r.blockerIssueId);
        if (!blockerIds.length) return { controlling: [] as string[], satisfied: [] as string[] };
        const statusRows = await db
          .select({ id: issues.id, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIds)));
        const statusById: Record<string, string> = {};
        for (const row of statusRows as Array<{ id: string; status: string }>) {
          statusById[row.id] = row.status;
        }
        return filterControllingBlockerIds(blockerIds, statusById);
      })();

      const childLanes = readAcceptanceLanesFromExecutionState(
        child.executionState as Record<string, unknown> | null,
      );
      const childHasControllingLane = Object.values(childLanes).some(
        (lane) => lane.state === "pending" || lane.state === "failed" || lane.state === "blocked",
      );
      const childTerminal = ["done", "cancelled", "canceled", "superseded"].includes(
        String(child.status).toLowerCase(),
      );
      const childEligible = !childHasControllingLane && !childTerminal;

      return {
        parentId: child.parentId,
        controllingBlockers: parentControl.controlling,
        satisfiedBlockers: parentControl.satisfied,
        childEligible,
      };
    },

    /**
     * Assignment preflight — fail closed before dispatch.
     */
    assignmentPreflight: async (input: {
      companyId: string;
      issueId: string;
      agentId: string | null;
      requiredCapabilities?: string[];
      workspaceReachable?: boolean;
      serviceRouteOk?: boolean;
      evidenceWritePathOk?: boolean;
    }) => {
      const failures: string[] = [];
      if (!input.agentId) failures.push("missing_assignee_agent");
      if (input.workspaceReachable === false) failures.push("workspace_unreachable");
      if (input.serviceRouteOk === false) failures.push("service_route_unavailable");
      if (input.evidenceWritePathOk === false) failures.push("evidence_write_path_unavailable");
      if (input.requiredCapabilities?.length) {
        // Capability matrix is agent-config specific; absence of proof = fail closed when list provided.
        failures.push("capabilities_unverified");
      }
      const issue = await loadIssue(input.companyId, input.issueId);
      if (!issue) failures.push("issue_not_found");
      return {
        ok: failures.length === 0,
        failures,
        mayDispatch: failures.length === 0,
      };
    },

    /**
     * Prevent liveness twin mint when source issue can be repaired (disposition missing).
     */
    shouldMintLivenessTwin: (input: {
      sourceIssueStatus: string;
      sourceHasMissingDisposition: boolean;
      openTwinCount: number;
    }) => {
      if (input.openTwinCount > 0) return { mint: false, reason: "twin_already_open" };
      if (
        input.sourceHasMissingDisposition
        && shouldSurfaceMissingDisposition(input.sourceIssueStatus)
      ) {
        return { mint: false, reason: "repair_source_disposition_first" };
      }
      return { mint: true, reason: "no_direct_repair_path" };
    },

    evaluateRuntimeNa: evaluateRuntimeNaEligibility,
    standingPolicyDocsOnly: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
    isSatisfiedBlockerStatus,
  };
}

export type AcceptanceLaneService = ReturnType<typeof createAcceptanceLaneService>;

/**
 * Hook helper for interaction resolution paths: only bind when status is accepted/approved.
 */
export function shouldAttemptLaneBindFromInteraction(status: string): boolean {
  const s = status.toLowerCase();
  return s === "accepted" || s === "approved";
}

/**
 * Extract optional lane bind payload from interaction payload/result.
 */
export function extractLaneBindFromInteractionPayload(
  payload: Record<string, unknown> | null | undefined,
  result: Record<string, unknown> | null | undefined,
): Partial<LaneBindingRequest> | null {
  const src = {
    ...(payload && typeof payload === "object" ? payload : {}),
    ...(result && typeof result === "object" ? result : {}),
  } as Record<string, unknown>;
  const guidance = (src.ownerGuidance && typeof src.ownerGuidance === "object"
    ? src.ownerGuidance
    : src) as Record<string, unknown>;
  const laneKey = String(
    guidance.acceptanceLaneKey
      ?? guidance.laneKey
      ?? src.acceptanceLaneKey
      ?? "",
  ).trim();
  const state = String(
    guidance.acceptanceLaneState
      ?? guidance.laneState
      ?? src.acceptanceLaneState
      ?? "",
  ).trim();
  if (!laneKey || !state) return null;
  return {
    laneKey,
    state: state as AcceptanceLaneState,
    option: (guidance.recommendedDisposition as string)
      ?? (guidance.option as string)
      ?? null,
    exactHead: (guidance.exactHead as string) ?? (src.exactHead as string) ?? null,
    artifactRef: (guidance.artifactRef as string) ?? (src.artifactRef as string) ?? null,
    pathClass: (guidance.pathClass as LaneBindingRequest["pathClass"]) ?? null,
    standingPolicyId: (guidance.standingPolicyId as string) ?? null,
    decisionId: (guidance.decisionId as string) ?? null,
  };
}

