/**
 * Thin closeout projection — no service imports (avoids issues.ts cycles).
 * F3: structured acceptance lanes beat optional prose claims.
 */
import type { AcceptanceLaneMap, AcceptanceLaneState } from "@paperclipai/shared";

const LANES_KEY = "acceptanceLanes" as const;

type EvidenceSource =
  | "accepted_interaction"
  | "structured_evidence"
  | "comment"
  | "cached_blocker_summary";

export interface CloseoutEvidenceClaim {
  source: EvidenceSource;
  laneKey: string;
  claimedState: AcceptanceLaneState;
  at?: string | null;
  text?: string | null;
}

function rank(source: EvidenceSource): number {
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

function readLanes(
  executionState: Record<string, unknown> | null | undefined,
): AcceptanceLaneMap {
  if (!executionState || typeof executionState !== "object") return {};
  const raw = executionState[LANES_KEY];
  if (!raw || typeof raw !== "object") return {};
  return { ...(raw as AcceptanceLaneMap) };
}

function resolveLaneState(input: {
  lanes: AcceptanceLaneMap;
  laneKey: string;
  claims?: CloseoutEvidenceClaim[];
}): AcceptanceLaneState | null {
  const structured = input.lanes[input.laneKey] ?? null;
  const claims = (input.claims ?? []).filter((c) => c.laneKey === input.laneKey);

  type Candidate = { source: EvidenceSource; state: AcceptanceLaneState; at: number };
  const candidates: Candidate[] = [];

  if (structured) {
    candidates.push({
      source: structured.bindingInteractionId ? "accepted_interaction" : "structured_evidence",
      state: structured.state,
      at: structured.updatedAt ? Date.parse(structured.updatedAt) || 0 : 0,
    });
  }
  for (const c of claims) {
    candidates.push({
      source: c.source,
      state: c.claimedState,
      at: c.at ? Date.parse(c.at) || 0 : 0,
    });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const rd = rank(b.source) - rank(a.source);
    if (rd !== 0) return rd;
    return b.at - a.at;
  });
  return candidates[0]!.state;
}

export function authoritativeAcceptanceLanesFromExecutionState(
  executionState: Record<string, unknown> | null | undefined,
): AcceptanceLaneMap {
  const raw = readLanes(executionState);
  const claimsRaw = executionState && typeof executionState === "object"
    ? executionState.acceptanceEvidenceClaims
    : null;
  const claims: CloseoutEvidenceClaim[] = Array.isArray(claimsRaw)
    ? (claimsRaw as CloseoutEvidenceClaim[]).filter(
      (c) =>
        c
        && typeof c === "object"
        && typeof c.laneKey === "string"
        && typeof c.claimedState === "string",
    )
    : [];
  const out: AcceptanceLaneMap = {};
  const keys = new Set([...Object.keys(raw), ...claims.map((c) => c.laneKey)]);
  for (const laneKey of keys) {
    const state = resolveLaneState({ lanes: raw, laneKey, claims });
    if (state == null) continue;
    const prev = raw[laneKey];
    out[laneKey] = {
      ...(prev ?? { state }),
      state,
      bindingInteractionId: prev?.bindingInteractionId,
      bindingDecisionId: prev?.bindingDecisionId,
      authority: prev?.authority,
      standingPolicyId: prev?.standingPolicyId,
      evidenceUri: prev?.evidenceUri,
      updatedAt: prev?.updatedAt,
      scope: prev?.scope,
    };
  }
  return out;
}

export function projectExecutionStateForCloseout(
  executionState: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!executionState || typeof executionState !== "object") return executionState;
  const lanes = authoritativeAcceptanceLanesFromExecutionState(executionState);
  if (Object.keys(lanes).length === 0) return executionState;
  return {
    ...executionState,
    acceptanceLanes: lanes,
    acceptanceLanesAuthoritative: true,
  };
}
