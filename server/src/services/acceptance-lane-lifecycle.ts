/**
 * Phase 3 — Decision/Gate lifecycle integration.
 *
 * Transaction model (documented):
 *   A — validated lane binding runs in the SAME database transaction as
 *       interaction resolution. If binding is required (structured lane
 *       payload present) and fails, BOTH acceptance and lane update roll back.
 *   Logging alone is never sufficient for a failed authoritative bind.
 *
 * Authoritative lane state is persisted on issue.executionState.acceptanceLanes.
 * Closeout target scope (exact head / artifact) lives on
 * issue.executionState.acceptanceCloseoutTarget when known.
 */
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, issues, issueRelations, projects } from "@paperclipai/db";
import {
  type AcceptanceLaneMap,
  type AcceptanceLaneState,
  type PathClass,
  type StructuredAcceptedDecision,
  bindAnsweredInteractionToLane,
  evaluateRuntimeNaEligibility,
  filterControllingBlockerIds,
  isSatisfiedBlockerStatus,
  shouldSurfaceMissingDisposition,
  STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
} from "@paperclipai/shared";
import {
  authoritativeAcceptanceLanesFromExecutionState,
} from "./acceptance-closeout-projection.js";
export { authoritativeAcceptanceLanesFromExecutionState } from "./acceptance-closeout-projection.js";

export const ACCEPTANCE_LANES_STATE_KEY = "acceptanceLanes" as const;
export const ACCEPTANCE_CLOSEOUT_TARGET_KEY = "acceptanceCloseoutTarget" as const;
export const ACCEPTANCE_BINDING_PENDING_KEY = "acceptanceBindingPending" as const;

export type EvidencePrecedenceSource =
  | "accepted_interaction"
  | "structured_evidence"
  | "comment"
  | "cached_blocker_summary";

/** Scope claimed by the structured decision / interaction payload. */
export interface AcceptedDecisionScope {
  issueId: string;
  artifactRef?: string | null;
  exactHead?: string | null;
  laneKey: string;
  pathClass?: PathClass | null;
  decisionId?: string | null;
  authority?: string | null;
  expiresAt?: string | null;
  option?: string | null;
}

/** Scope of the live closeout target loaded from the issue / DB — independent of the decision. */
export interface CurrentTargetScope {
  issueId: string;
  artifactRef?: string | null;
  exactHead?: string | null;
  laneKey: string;
  pathClass?: PathClass | null;
  governingPolicyId?: string | null;
}

export interface LaneBindingRequest {
  companyId: string;
  issueId: string;
  laneKey: string;
  state: AcceptanceLaneState;
  interactionId: string;
  /** Must come from persisted interaction row status/result — never hardcode. */
  resolutionStatus: StructuredAcceptedDecision["resolutionStatus"];
  option?: string | null;
  /** Decision-claimed fields (from interaction payload/result). */
  acceptedDecisionScope: AcceptedDecisionScope;
  /** Issue/DB-loaded closeout target (independent). */
  currentTargetScope: CurrentTargetScope;
  standingPolicyId?: string | null;
  evidenceUri?: string | null;
  updatedAt?: string;
}

export interface LaneBindingResult {
  applied: boolean;
  code: string;
  message: string | null;
  lanes: AcceptanceLaneMap;
  issueId: string;
  parentRecalc?: {
    parentId: string | null;
    controllingBlockers: string[];
    satisfiedBlockers: string[];
    parentEligible: boolean;
    childEligible: boolean;
  };
}

export interface CloseoutEvidenceClaim {
  source: EvidencePrecedenceSource;
  laneKey: string;
  claimedState: AcceptanceLaneState;
  at?: string | null;
  text?: string | null;
}

export function readAcceptanceLanesFromExecutionState(
  executionState: Record<string, unknown> | null | undefined,
): AcceptanceLaneMap {
  if (!executionState || typeof executionState !== "object") return {};
  const raw = executionState[ACCEPTANCE_LANES_STATE_KEY];
  if (!raw || typeof raw !== "object") return {};
  return { ...(raw as AcceptanceLaneMap) };
}

export function readCloseoutTargetFromExecutionState(
  executionState: Record<string, unknown> | null | undefined,
): {
  exactHead?: string | null;
  artifactRef?: string | null;
  pathClass?: PathClass | null;
  governingPolicyId?: string | null;
} {
  if (!executionState || typeof executionState !== "object") return {};
  const raw = executionState[ACCEPTANCE_CLOSEOUT_TARGET_KEY];
  if (!raw || typeof raw !== "object") return {};
  const t = raw as Record<string, unknown>;
  return {
    exactHead: (t.exactHead as string) ?? null,
    artifactRef: (t.artifactRef as string) ?? null,
    pathClass: (t.pathClass as PathClass) ?? null,
    governingPolicyId: (t.governingPolicyId as string) ?? null,
  };
}

export function writeAcceptanceLanesIntoExecutionState(
  executionState: Record<string, unknown> | null | undefined,
  lanes: AcceptanceLaneMap,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  const base = executionState && typeof executionState === "object" ? { ...executionState } : {};
  base[ACCEPTANCE_LANES_STATE_KEY] = lanes;
  base.acceptanceLanesUpdatedAt = new Date().toISOString();
  if (extras) Object.assign(base, extras);
  // Clear pending-binding marker on successful write.
  delete base[ACCEPTANCE_BINDING_PENDING_KEY];
  return base;
}

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
 * Resolve authoritative lane state for a key given structured lanes + optional
 * prose/cache claims. Structured accepted_interaction always beats older comments.
 */
export function resolveLaneStateWithEvidencePrecedence(input: {
  lanes: AcceptanceLaneMap;
  laneKey: string;
  claims?: CloseoutEvidenceClaim[];
}): {
  state: AcceptanceLaneState | null;
  winningSource: EvidencePrecedenceSource | "none";
  blockedHumanGate: boolean;
} {
  const structured = input.lanes[input.laneKey] ?? null;
  const claims = (input.claims ?? []).filter((c) => c.laneKey === input.laneKey);

  type Candidate = {
    source: EvidencePrecedenceSource;
    state: AcceptanceLaneState;
    at: number;
  };
  const candidates: Candidate[] = [];

  if (structured) {
    candidates.push({
      source: structured.bindingInteractionId ? "accepted_interaction" : "structured_evidence",
      state: structured.state,
      at: structured.updatedAt ? Date.parse(structured.updatedAt) || 0 : Number.MAX_SAFE_INTEGER,
    });
  }
  for (const c of claims) {
    candidates.push({
      source: c.source,
      state: c.claimedState,
      at: c.at ? Date.parse(c.at) || 0 : 0,
    });
  }
  if (candidates.length === 0) {
    return { state: null, winningSource: "none", blockedHumanGate: false };
  }

  candidates.sort((a, b) => {
    const rankDiff = evidencePrecedenceRank(b.source) - evidencePrecedenceRank(a.source);
    if (rankDiff !== 0) return rankDiff;
    return b.at - a.at;
  });
  const win = candidates[0]!;
  // Older comment claiming "runtime required" cannot reopen a human gate when
  // structured accepted interaction already set not_applicable/satisfied.
  const blockedHumanGate =
    win.source === "comment"
    && (win.state === "pending" || win.state === "blocked" || win.state === "failed");
  return {
    state: win.state,
    winningSource: win.source,
    blockedHumanGate: win.source === "accepted_interaction" ? false : blockedHumanGate,
  };
}

function scopesMatch(
  decision: AcceptedDecisionScope,
  target: CurrentTargetScope,
): { ok: true } | { ok: false; code: string; message: string } {
  if (decision.issueId !== target.issueId) {
    return {
      ok: false,
      code: "refused_issue_mismatch",
      message: `decision issue ${decision.issueId} != target issue ${target.issueId}`,
    };
  }
  if (decision.laneKey !== target.laneKey) {
    return {
      ok: false,
      code: "refused_lane_mismatch",
      message: `decision lane ${decision.laneKey} != target lane ${target.laneKey}`,
    };
  }
  if (target.exactHead) {
    if (!decision.exactHead) {
      return {
        ok: false,
        code: "refused_exact_head_mismatch",
        message: "decision missing exactHead while target requires one",
      };
    }
    const a = decision.exactHead.toLowerCase();
    const b = target.exactHead.toLowerCase();
    if (!a.startsWith(b) && !b.startsWith(a)) {
      return {
        ok: false,
        code: "refused_exact_head_mismatch",
        message: `exact head mismatch decision=${decision.exactHead} target=${target.exactHead}`,
      };
    }
  }
  if (target.artifactRef) {
    if (!decision.artifactRef) {
      return {
        ok: false,
        code: "refused_artifact_mismatch",
        message: "decision missing artifactRef while target requires one",
      };
    }
    if (decision.artifactRef !== target.artifactRef) {
      return {
        ok: false,
        code: "refused_artifact_mismatch",
        message: `artifact mismatch decision=${decision.artifactRef} target=${target.artifactRef}`,
      };
    }
  }
  if (
    target.pathClass
    && decision.pathClass
    && target.pathClass !== decision.pathClass
  ) {
    return {
      ok: false,
      code: "refused_path_class_mismatch",
      message: `pathClass mismatch decision=${decision.pathClass} target=${target.pathClass}`,
    };
  }
  return { ok: true };
}

/**
 * Pure bind with independent decision vs target scopes.
 * Mismatch detection is possible because expected comes only from currentTargetScope.
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

  const scopeCheck = scopesMatch(request.acceptedDecisionScope, request.currentTargetScope);
  if (!scopeCheck.ok) {
    return {
      applied: false,
      code: scopeCheck.code,
      message: scopeCheck.message,
      lanes: current,
      issueId: request.issueId,
    };
  }

  const decision: StructuredAcceptedDecision = {
    interactionId: request.interactionId,
    resolutionStatus: request.resolutionStatus,
    laneKey: request.acceptedDecisionScope.laneKey,
    option: request.acceptedDecisionScope.option ?? request.option ?? null,
    exactHead: request.acceptedDecisionScope.exactHead ?? null,
    artifactRef: request.acceptedDecisionScope.artifactRef ?? null,
    issueId: request.acceptedDecisionScope.issueId,
    pathClass: request.acceptedDecisionScope.pathClass ?? null,
    expiresAt: request.acceptedDecisionScope.expiresAt ?? null,
    decisionId: request.acceptedDecisionScope.decisionId ?? null,
  };

  const result = bindAnsweredInteractionToLane({
    lanes: current,
    laneKey: request.laneKey,
    state: request.state,
    interactionId: request.interactionId,
    resolutionStatus: request.resolutionStatus,
    bindingDecisionId: request.acceptedDecisionScope.decisionId ?? null,
    evidenceUri: request.evidenceUri ?? null,
    updatedAt: request.updatedAt,
    scope: {
      pathClass: request.acceptedDecisionScope.pathClass ?? undefined,
      exactHead: request.acceptedDecisionScope.exactHead ?? null,
      artifact: request.acceptedDecisionScope.artifactRef ?? null,
      issueId: request.acceptedDecisionScope.issueId,
    },
    runtimeNa:
      request.state === "not_applicable"
        ? {
            // F2: pathClass ONLY from trusted currentTargetScope — never decision payload.
            pathClass: request.currentTargetScope.pathClass ?? null,
            standingPolicyId: request.standingPolicyId ?? null,
            decision: request.standingPolicyId ? null : decision,
            expected: {
              exactHead: request.currentTargetScope.exactHead ?? null,
              artifactRef: request.currentTargetScope.artifactRef ?? null,
              issueId: request.currentTargetScope.issueId,
              laneKey: request.currentTargetScope.laneKey,
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

function parseCapabilityList(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  // capabilities is free text; accept comma/newline/JSON-array forms
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(String).map((s) => s.trim()).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return trimmed
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
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
        projectId: issues.projectId,
        identifier: issues.identifier,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * F1 — lost-update safe persist:
   * 1) SELECT ... FOR UPDATE on the issue row
   * 2) re-read current executionState under the lock
   * 3) merge ONLY acceptance lane keys (preserve concurrent runtime keys)
   * 4) write the merged object
   */
  async function persistLanes(
    companyId: string,
    issueId: string,
    _staleExecutionState: Record<string, unknown> | null | undefined,
    lanes: AcceptanceLaneMap,
  ) {
    await db.execute(
      sql`select id from issues where company_id = ${companyId} and id = ${issueId} for update`,
    );
    const lockedRows = await db
      .select({
        id: issues.id,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .limit(1);
    const locked = lockedRows[0];
    if (!locked) {
      throw new Error(`issue ${issueId} missing under lock during acceptance lane persist`);
    }
    const current =
      locked.executionState && typeof locked.executionState === "object"
        ? { ...(locked.executionState as Record<string, unknown>) }
        : {};
    const nextState = writeAcceptanceLanesIntoExecutionState(current, lanes);
    await db
      .update(issues)
      .set({
        executionState: nextState,
        updatedAt: new Date(),
      })
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    return nextState;
  }

  async function listControllingBlockersInner(companyId: string, issueId: string) {
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
  }

  async function recalculateParentGateInner(companyId: string, childIssueId: string) {
    const child = await loadIssue(companyId, childIssueId);
    if (!child?.parentId) {
      return {
        parentId: null as string | null,
        controllingBlockers: [] as string[],
        satisfiedBlockers: [] as string[],
        parentEligible: false,
        childEligible: false,
      };
    }
    const parentControl = await listControllingBlockersInner(companyId, child.parentId);
    // F3: production closeout aggregation uses evidence precedence.
    const childLanes = authoritativeAcceptanceLanesFromExecutionState(
      child.executionState as Record<string, unknown> | null,
    );
    const childHasControllingLane = Object.values(childLanes).some(
      (lane) => lane.state === "pending" || lane.state === "failed" || lane.state === "blocked",
    );
    const childTerminal = ["done", "cancelled", "canceled", "superseded"].includes(
      String(child.status).toLowerCase(),
    );
    // Child is "satisfied for parent edge" when terminal OR no controlling lanes remain
    // (e.g. runtime N/A + other lanes still pending is NOT fully satisfied — only the
    // blocker edge status + parent controlling set matter for parent eligibility).
    const parentEligible = parentControl.controlling.length === 0;
    const childEligible = !childHasControllingLane && !childTerminal;

    // Persist parent eligibility snapshot (no auto-wake).
    const parent = await loadIssue(companyId, child.parentId);
    if (parent) {
      await db.execute(
        sql`select id from issues where company_id = ${companyId} and id = ${child.parentId} for update`,
      );
      const parentLockedRows = await db
        .select({ id: issues.id, executionState: issues.executionState })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, child.parentId!)))
        .limit(1);
      const parentLocked = parentLockedRows[0];
      const parentExec =
        parentLocked?.executionState && typeof parentLocked.executionState === "object"
          ? { ...(parentLocked.executionState as Record<string, unknown>) }
          : parent.executionState && typeof parent.executionState === "object"
            ? { ...(parent.executionState as Record<string, unknown>) }
            : {};
      parentExec.gateEligibility = {
        parentEligible,
        controllingBlockers: parentControl.controlling,
        satisfiedBlockers: parentControl.satisfied,
        recalculatedFromChildId: childIssueId,
        recalculatedAt: new Date().toISOString(),
      };
      await db
        .update(issues)
        .set({ executionState: parentExec, updatedAt: new Date() })
        .where(and(eq(issues.companyId, companyId), eq(issues.id, child.parentId)));
    }

    return {
      parentId: child.parentId,
      controllingBlockers: parentControl.controlling,
      satisfiedBlockers: parentControl.satisfied,
      parentEligible,
      childEligible,
    };
  }

  return {
    /**
     * Bind an accepted interaction result onto structured acceptance lanes.
     * Idempotent. Does not wake agents. Uses the db handle (caller should pass
     * the same transaction client when binding inside interaction resolution).
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

      // Rebuild currentTargetScope from DB if caller left head/artifact empty —
      // never invent from the decision payload.
      const storedTarget = readCloseoutTargetFromExecutionState(
        issue.executionState as Record<string, unknown> | null,
      );
      // F2: pathClass only from locked DB closeout target — never decision/caller invent.
      const trustedPathClass = storedTarget.pathClass ?? null;
      const currentTargetScope: CurrentTargetScope = {
        issueId: issue.id,
        laneKey: request.currentTargetScope.laneKey || request.laneKey,
        exactHead: storedTarget.exactHead ?? request.currentTargetScope.exactHead ?? null,
        artifactRef: storedTarget.artifactRef ?? request.currentTargetScope.artifactRef ?? null,
        pathClass: trustedPathClass,
        governingPolicyId:
          storedTarget.governingPolicyId ?? request.currentTargetScope.governingPolicyId ?? null,
      };

      const bound = bindLaneTransitionIdempotent(
        readAcceptanceLanesFromExecutionState(issue.executionState as Record<string, unknown> | null),
        { ...request, currentTargetScope },
      );
      if (!bound.applied) return bound;
      if (bound.code === "ok_idempotent") {
        const parentRecalc = await recalculateParentGateInner(request.companyId, request.issueId);
        return { ...bound, parentRecalc };
      }

      await persistLanes(
        request.companyId,
        request.issueId,
        issue.executionState as Record<string, unknown> | null,
        bound.lanes,
      );

      // Child closeout already rewritten via lanes; recalculate controlling edges + parent.
      await listControllingBlockersInner(request.companyId, request.issueId);
      const parentRecalc = await recalculateParentGateInner(request.companyId, request.issueId);
      return { ...bound, parentRecalc };
    },

    listControllingBlockers: (companyId: string, issueId: string) =>
      listControllingBlockersInner(companyId, issueId),

    recalculateParentGate: (companyId: string, childIssueId: string) =>
      recalculateParentGateInner(companyId, childIssueId),

    /**
     * Real assignment preflight against agent identity, capability grants,
     * issue-required capabilities, workspace/repo reachability, service route,
     * and evidence-write path markers on the issue.
     */
    assignmentPreflight: async (input: {
      companyId: string;
      issueId: string;
      agentId: string | null;
      /** Optional override; otherwise read from issue.executionState.requiredCapabilities */
      requiredCapabilities?: string[];
      serviceRouteOk?: boolean;
      evidenceWritePathOk?: boolean;
    }) => {
      const failures: string[] = [];
      if (!input.agentId) {
        failures.push("missing_assignee_agent");
        return { ok: false, failures, mayDispatch: false };
      }

      const agentRows = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          status: agents.status,
          capabilities: agents.capabilities,
          adapterType: agents.adapterType,
          pauseReason: agents.pauseReason,
        })
        .from(agents)
        .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
        .limit(1);
      const agent = agentRows[0];
      if (!agent) {
        failures.push("agent_not_found");
        return { ok: false, failures, mayDispatch: false };
      }
      if (agent.pauseReason) failures.push("agent_paused");
      if (String(agent.status).toLowerCase() === "error") failures.push("agent_error_status");

      const issue = await loadIssue(input.companyId, input.issueId);
      if (!issue) {
        failures.push("issue_not_found");
        return { ok: false, failures, mayDispatch: false };
      }

      const exec =
        issue.executionState && typeof issue.executionState === "object"
          ? (issue.executionState as Record<string, unknown>)
          : {};
      const requiredFromIssue = Array.isArray(exec.requiredCapabilities)
        ? (exec.requiredCapabilities as unknown[]).map(String)
        : typeof exec.requiredCapabilities === "string"
          ? parseCapabilityList(exec.requiredCapabilities)
          : [];
      const required = [
        ...(input.requiredCapabilities ?? []),
        ...requiredFromIssue,
      ].map((s) => s.trim()).filter(Boolean);

      // F5: fail-closed only when a capability gate is explicitly declared.
      // Default issues without a gate keep product dispatch behavior (agent health only).
      // Bypass is prevented by requiring an explicit gate before capability-free dispatch
      // is treated as authorized for gated work.
      const gateMode = String(
        exec.requiredCapabilityGate
        ?? exec.capabilityGate
        ?? "",
      ).toLowerCase();
      const hasExplicitCapabilityContract =
        Object.prototype.hasOwnProperty.call(exec, "requiredCapabilities")
        || gateMode === "strict"
        || gateMode === "required";
      if (required.length === 0 && (gateMode === "strict" || gateMode === "required")) {
        failures.push("required_capabilities_unspecified");
      } else if (required.length === 0 && hasExplicitCapabilityContract && gateMode === "strict") {
        failures.push("required_capabilities_unspecified");
      }

      const granted = new Set(parseCapabilityList(agent.capabilities).map((s) => s.toLowerCase()));
      for (const cap of required) {
        if (!granted.has(cap.toLowerCase())) {
          failures.push(`missing_capability:${cap}`);
        }
      }

      // Workspace / repository reachability via linked project when present.
      if (issue.projectId) {
        const projRows = await db
          .select({
            id: projects.id,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(and(eq(projects.id, issue.projectId), eq(projects.companyId, input.companyId)))
          .limit(1);
        const proj = projRows[0];
        if (!proj) {
          failures.push("project_unreachable");
        } else {
          const policy = proj.executionWorkspacePolicy as Record<string, unknown> | null;
          if (policy && policy.requireWorkspace === true) {
            const hasWorkspaceHint =
              Boolean(policy.defaultCwd)
              || Boolean(policy.repoUrl)
              || Boolean(exec.workspaceCwd)
              || Boolean(exec.executionWorkspaceId);
            if (!hasWorkspaceHint) failures.push("workspace_unreachable");
          }
        }
      }

      if (input.serviceRouteOk === false) failures.push("service_route_unavailable");
      if (input.evidenceWritePathOk === false) failures.push("evidence_write_path_unavailable");
      if (exec.requireEvidenceWritePath === true && exec.evidenceWritePathOk === false) {
        failures.push("evidence_write_path_unavailable");
      }
      if (exec.serviceRouteOk === false) failures.push("service_route_unavailable");

      // Adapter type presence is a minimal service-route signal.
      if (!agent.adapterType) failures.push("service_route_unavailable");

      return {
        ok: failures.length === 0,
        failures,
        mayDispatch: failures.length === 0,
        agentId: agent.id,
        requiredCapabilities: required,
        grantedCapabilities: [...granted],
      };
    },

    /**
     * Prevent liveness twin mint when source issue can be repaired, or an open twin exists.
     */
    shouldMintLivenessTwin: (input: {
      sourceIssueStatus: string;
      sourceHasMissingDisposition: boolean;
      openTwinCount: number;
      unrecoverable?: boolean;
    }) => {
      if (input.openTwinCount > 0) return { mint: false, reason: "twin_already_open" as const };
      if (
        input.sourceHasMissingDisposition
        && shouldSurfaceMissingDisposition(input.sourceIssueStatus)
      ) {
        return { mint: false, reason: "repair_source_disposition_first" as const };
      }
      if (input.unrecoverable === false) {
        return { mint: false, reason: "source_directly_repairable" as const };
      }
      return { mint: true, reason: "no_direct_repair_path" as const };
    },

    evaluateRuntimeNa: evaluateRuntimeNaEligibility,
    standingPolicyDocsOnly: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
    isSatisfiedBlockerStatus,

    buildCurrentTargetScopeFromIssue(
      issue: { id: string; executionState?: unknown },
      laneKey: string,
    ): CurrentTargetScope {
      const stored = readCloseoutTargetFromExecutionState(
        issue.executionState as Record<string, unknown> | null,
      );
      return {
        issueId: issue.id,
        laneKey,
        exactHead: stored.exactHead ?? null,
        artifactRef: stored.artifactRef ?? null,
        pathClass: stored.pathClass ?? null,
        governingPolicyId: stored.governingPolicyId ?? null,
      };
    },

    /** Production closeout snapshot with evidence precedence (F3). */
    getAuthoritativeCloseoutLanes(executionState: Record<string, unknown> | null | undefined) {
      return authoritativeAcceptanceLanesFromExecutionState(executionState);
    },
  };
}

export type AcceptanceLaneService = ReturnType<typeof createAcceptanceLaneService>;

/**
 * Only accepted/approved may bind. "answered" alone is insufficient unless the
 * caller has already mapped a structured affirmative decision onto accepted.
 */
export function shouldAttemptLaneBindFromInteraction(status: string): boolean {
  const s = status.toLowerCase();
  return s === "accepted" || s === "approved";
}

/**
 * Derive bindable resolution from the *persisted* interaction row.
 * ask_user_questions terminates as "answered"; bind only when the payload
 * carries structured lane fields AND the answers select a non-reject option
 * that the payload marks as a structured acceptance (or option id matches
 * ownerGuidance.recommendedDisposition / acceptance option ids).
 */
export function resolveBindableResolutionFromPersistedInteraction(row: {
  status: string;
  kind?: string | null;
  payload?: unknown;
  result?: unknown;
}): StructuredAcceptedDecision["resolutionStatus"] | null {
  const status = String(row.status ?? "").toLowerCase();
  if (status === "accepted" || status === "approved") return status;
  if (status === "rejected" || status === "cancelled" || status === "expired" || status === "pending") {
    return null;
  }
  if (status !== "answered") return null;

  const payload = (row.payload && typeof row.payload === "object")
    ? row.payload as Record<string, unknown>
    : {};
  const result = (row.result && typeof row.result === "object")
    ? row.result as Record<string, unknown>
    : {};
  const partial = extractLaneBindFromInteractionPayload(payload, result);
  if (!partial?.laneKey || !partial?.state) return null;

  // Reject-like options must not bind.
  const option = String(partial.option ?? "").toLowerCase();
  if (option.includes("reject") || option.includes("decline") || option === "no") return null;

  // Prefer explicit answers when present.
  const answers = Array.isArray(result.answers) ? result.answers : [];
  if (answers.length > 0) {
    const selected = answers
      .flatMap((a: any) => {
        if (!a || typeof a !== "object") return [];
        const ids = a.selectedOptionIds ?? a.optionIds ?? [];
        return Array.isArray(ids) ? ids.map(String) : [];
      })
      .map((s) => s.toLowerCase());
    if (selected.some((s) => s.includes("reject") || s.includes("decline"))) return null;
  }

  // Structured lane payload + answered = treat as accepted for bind authority only.
  return "accepted";
}

export function extractLaneBindFromInteractionPayload(
  payload: Record<string, unknown> | null | undefined,
  result: Record<string, unknown> | null | undefined,
): Partial<{
  laneKey: string;
  state: AcceptanceLaneState;
  option: string | null;
  exactHead: string | null;
  artifactRef: string | null;
  pathClass: PathClass | null;
  standingPolicyId: string | null;
  decisionId: string | null;
  expiresAt: string | null;
  authority: string | null;
}> | null {
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

  // Prefer selected option from answers when recommendedDisposition absent.
  let option =
    (guidance.recommendedDisposition as string)
    ?? (guidance.option as string)
    ?? (src.option as string)
    ?? null;
  const answers = Array.isArray(src.answers) ? src.answers : [];
  if (!option && answers.length > 0) {
    for (const a of answers) {
      if (a && typeof a === "object") {
        const ids = (a as any).selectedOptionIds ?? (a as any).optionIds;
        if (Array.isArray(ids) && ids[0]) {
          option = String(ids[0]);
          break;
        }
      }
    }
  }

  return {
    laneKey,
    state: state as AcceptanceLaneState,
    option,
    exactHead: (guidance.exactHead as string) ?? (src.exactHead as string) ?? null,
    artifactRef: (guidance.artifactRef as string) ?? (src.artifactRef as string) ?? null,
    pathClass: (guidance.pathClass as PathClass) ?? null,
    standingPolicyId: (guidance.standingPolicyId as string) ?? null,
    decisionId: (guidance.decisionId as string) ?? null,
    expiresAt: (guidance.expiresAt as string) ?? (src.expiresAt as string) ?? null,
    authority: (guidance.authority as string) ?? null,
  };
}

/**
 * Build a LaneBindingRequest from a persisted interaction + loaded issue.
 * Returns null when no structured lane payload is present (accept proceeds without bind).
 */
export function buildLaneBindingRequestFromPersisted(input: {
  companyId: string;
  issue: { id: string; executionState?: unknown };
  interaction: {
    id: string;
    status: string;
    kind?: string | null;
    payload?: unknown;
    result?: unknown;
  };
}): LaneBindingRequest | null {
  const bindable = resolveBindableResolutionFromPersistedInteraction(input.interaction);
  if (!bindable) return null;
  if (!shouldAttemptLaneBindFromInteraction(bindable)) return null;

  const payload = (input.interaction.payload && typeof input.interaction.payload === "object")
    ? input.interaction.payload as Record<string, unknown>
    : null;
  const result = (input.interaction.result && typeof input.interaction.result === "object")
    ? input.interaction.result as Record<string, unknown>
    : null;
  const partial = extractLaneBindFromInteractionPayload(payload, result);
  if (!partial?.laneKey || !partial?.state) return null;

  const stored = readCloseoutTargetFromExecutionState(
    input.issue.executionState as Record<string, unknown> | null,
  );

  const acceptedDecisionScope: AcceptedDecisionScope = {
    issueId: input.issue.id,
    laneKey: partial.laneKey,
    exactHead: partial.exactHead ?? null,
    artifactRef: partial.artifactRef ?? null,
    pathClass: partial.pathClass ?? null,
    decisionId: partial.decisionId ?? null,
    authority: partial.authority ?? null,
    expiresAt: partial.expiresAt ?? null,
    option: partial.option ?? null,
  };

  const currentTargetScope: CurrentTargetScope = {
    issueId: input.issue.id,
    laneKey: partial.laneKey,
    // Target head/artifact/pathClass come from issue closeout target ONLY (F2).
    exactHead: stored.exactHead ?? null,
    artifactRef: stored.artifactRef ?? null,
    pathClass: stored.pathClass ?? null,
    governingPolicyId: stored.governingPolicyId ?? null,
  };

  return {
    companyId: input.companyId,
    issueId: input.issue.id,
    laneKey: partial.laneKey,
    state: partial.state,
    interactionId: input.interaction.id,
    resolutionStatus: bindable,
    option: partial.option ?? null,
    acceptedDecisionScope,
    currentTargetScope,
    standingPolicyId: partial.standingPolicyId ?? null,
  };
}

