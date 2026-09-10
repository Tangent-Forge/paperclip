import { describe, expect, it } from "vitest";
import {
  bindLaneTransitionIdempotent,
  evidencePrecedenceRank,
  preferEvidenceSource,
  readAcceptanceLanesFromExecutionState,
  resolveBindableResolutionFromPersistedInteraction,
  resolveLaneStateWithEvidencePrecedence,
  shouldAttemptLaneBindFromInteraction,
  writeAcceptanceLanesIntoExecutionState,
  extractLaneBindFromInteractionPayload,
  createAcceptanceLaneService,
  buildLaneBindingRequestFromPersisted,
  authoritativeAcceptanceLanesFromExecutionState,
  type LaneBindingRequest,
} from "./acceptance-lane-lifecycle.js";
import { STANDING_POLICY_DOCS_ONLY_RUNTIME_NA } from "@paperclipai/shared";

function baseReq(over: Partial<LaneBindingRequest> & Pick<LaneBindingRequest, "acceptedDecisionScope" | "currentTargetScope">): LaneBindingRequest {
  return {
    companyId: "co",
    issueId: over.issueId ?? "iss-1",
    laneKey: over.laneKey ?? "runtime_target_host",
    state: over.state ?? "not_applicable",
    interactionId: over.interactionId ?? "ix-1",
    resolutionStatus: over.resolutionStatus ?? "accepted",
    option: over.option ?? "runtime_not_applicable",
    standingPolicyId: over.standingPolicyId ?? null,
    acceptedDecisionScope: over.acceptedDecisionScope,
    currentTargetScope: over.currentTargetScope,
  };
}

function shouldMintLivenessTwinHelper(input: {
  sourceIssueStatus: string;
  sourceHasMissingDisposition: boolean;
  openTwinCount: number;
  unrecoverable?: boolean;
}) {
  return createAcceptanceLaneService({} as any).shouldMintLivenessTwin(input);
}

describe("acceptance-lane-lifecycle Phase 3 corrections", () => {
  it("PAP-3221-shaped accepted runtime N/A binds when decision matches target scope; review/scan stay pending", () => {
    const head = "758457e40184c86410ab57c07a035ab1a4a7ae58";
    const artifact = "Tangent-Forge/agent-systems-hub#491";
    const r = bindLaneTransitionIdempotent(
      {
        independent_review: { state: "pending" },
        exact_head_secret_scan: { state: "pending" },
        runtime_target_host: { state: "pending" },
      },
      baseReq({
        issueId: "PAP-3221",
        interactionId: "afdc7368-11e6-4a68-bf6b-d8f085799b2d",
        acceptedDecisionScope: {
          issueId: "PAP-3221",
          laneKey: "runtime_target_host",
          exactHead: head,
          artifactRef: artifact,
          pathClass: "documentation",
          option: "runtime_not_applicable",
        },
        currentTargetScope: {
          issueId: "PAP-3221",
          laneKey: "runtime_target_host",
          exactHead: head,
          artifactRef: artifact,
          pathClass: "documentation",
        },
      }),
    );
    expect(r.applied).toBe(true);
    expect(r.lanes.runtime_target_host?.state).toBe("not_applicable");
    expect(r.lanes.independent_review?.state).toBe("pending");
    expect(r.lanes.exact_head_secret_scan?.state).toBe("pending");
  });

  it("rejected decision does not bind", () => {
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        resolutionStatus: "rejected",
        acceptedDecisionScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "abc",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "abc",
        },
      }),
    );
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_decision_rejected");
  });

  it("answered-only (not accepted) does not bind", () => {
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        resolutionStatus: "answered",
        acceptedDecisionScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "abc",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "abc",
        },
      }),
    );
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_decision_not_accepted");
  });

  it("exact-head mismatch between decision and target refuses", () => {
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        acceptedDecisionScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "1111111111111111111111111111111111111111",
          artifactRef: "art-a",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "2222222222222222222222222222222222222222",
          artifactRef: "art-a",
        },
      }),
    );
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_exact_head_mismatch");
  });

  it("artifact mismatch between decision and target refuses", () => {
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        acceptedDecisionScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "758457e",
          artifactRef: "wrong-artifact",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "758457e",
          artifactRef: "canonical-artifact",
        },
      }),
    );
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_artifact_mismatch");
  });

  it("issue mismatch refuses", () => {
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        issueId: "iss-1",
        acceptedDecisionScope: {
          issueId: "other-issue",
          laneKey: "runtime_target_host",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
        },
      }),
    );
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_issue_mismatch");
  });

  it("lane mismatch refuses", () => {
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        acceptedDecisionScope: {
          issueId: "iss-1",
          laneKey: "other_lane",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
        },
      }),
    );
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_lane_mismatch");
  });

  it("docs-only without standing policy or matching accepted decision refuses when no decision authority", () => {
    // standing policy path without documentation class
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
        acceptedDecisionScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          pathClass: "executable",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          pathClass: "executable",
        },
      }),
    );
    expect(r.applied).toBe(false);
  });

  it("generated artifact without policy refuses", () => {
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
        acceptedDecisionScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          pathClass: "generated",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          pathClass: "generated",
        },
      }),
    );
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_generated_default");
  });

  it("expired decision refuses", () => {
    const r = bindLaneTransitionIdempotent(
      { runtime_target_host: { state: "pending" } },
      baseReq({
        acceptedDecisionScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "abc",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
        currentTargetScope: {
          issueId: "iss-1",
          laneKey: "runtime_target_host",
          exactHead: "abc",
        },
      }),
    );
    expect(r.applied).toBe(false);
    expect(r.code).toBe("refused_decision_expired");
  });

  it("idempotent reprocessing returns ok_idempotent", () => {
    const req = baseReq({
      interactionId: "ix",
      standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
      acceptedDecisionScope: {
        issueId: "iss-1",
        laneKey: "runtime_target_host",
        exactHead: "abc",
        pathClass: "documentation",
      },
      currentTargetScope: {
        issueId: "iss-1",
        laneKey: "runtime_target_host",
        exactHead: "abc",
        pathClass: "documentation",
      },
    });
    const first = bindLaneTransitionIdempotent({}, req);
    expect(first.applied).toBe(true);
    const second = bindLaneTransitionIdempotent(first.lanes, req);
    expect(second.code).toBe("ok_idempotent");
  });

  it("evidence precedence: newer accepted interaction beats older comment claiming runtime required", () => {
    expect(evidencePrecedenceRank("accepted_interaction")).toBeGreaterThan(
      evidencePrecedenceRank("comment"),
    );
    expect(preferEvidenceSource("comment", "accepted_interaction")).toBe(
      "accepted_interaction",
    );

    const resolved = resolveLaneStateWithEvidencePrecedence({
      lanes: {
        runtime_target_host: {
          state: "not_applicable",
          bindingInteractionId: "afdc7368",
          updatedAt: "2026-09-09T00:45:55.000Z",
        },
      },
      laneKey: "runtime_target_host",
      claims: [
        {
          source: "comment",
          laneKey: "runtime_target_host",
          claimedState: "pending",
          at: "2026-09-09T06:20:00.000Z",
          text: "runtime still required",
        },
      ],
    });
    expect(resolved.state).toBe("not_applicable");
    expect(resolved.winningSource).toBe("accepted_interaction");
    expect(resolved.blockedHumanGate).toBe(false);
  });

  it("executionState read/write round-trip", () => {
    const written = writeAcceptanceLanesIntoExecutionState(null, {
      runtime: { state: "not_applicable", bindingInteractionId: "x" },
    });
    const read = readAcceptanceLanesFromExecutionState(written);
    expect(read.runtime?.state).toBe("not_applicable");
  });

  it("only accepted/approved interaction statuses attempt bind", () => {
    expect(shouldAttemptLaneBindFromInteraction("accepted")).toBe(true);
    expect(shouldAttemptLaneBindFromInteraction("approved")).toBe(true);
    expect(shouldAttemptLaneBindFromInteraction("answered")).toBe(false);
    expect(shouldAttemptLaneBindFromInteraction("rejected")).toBe(false);
  });

  it("persisted answered + structured lane payload maps to bindable accepted", () => {
    const status = resolveBindableResolutionFromPersistedInteraction({
      status: "answered",
      kind: "ask_user_questions",
      payload: {
        ownerGuidance: {
          acceptanceLaneKey: "runtime_target_host",
          acceptanceLaneState: "not_applicable",
          recommendedDisposition: "runtime_not_applicable",
          exactHead: "758457e",
        },
      },
      result: {
        answers: [{ selectedOptionIds: ["runtime_not_applicable"] }],
      },
    });
    expect(status).toBe("accepted");
  });

  it("persisted answered without lane payload is not bindable", () => {
    expect(
      resolveBindableResolutionFromPersistedInteraction({
        status: "answered",
        payload: { questions: [] },
        result: { answers: [] },
      }),
    ).toBeNull();
  });

  it("persisted rejected is not bindable", () => {
    expect(
      resolveBindableResolutionFromPersistedInteraction({
        status: "rejected",
        payload: {
          ownerGuidance: {
            acceptanceLaneKey: "runtime_target_host",
            acceptanceLaneState: "not_applicable",
          },
        },
      }),
    ).toBeNull();
  });

  it("buildLaneBindingRequest uses issue target scope not decision head alone", () => {
    const req = buildLaneBindingRequestFromPersisted({
      companyId: "co",
      issue: {
        id: "iss-1",
        executionState: {
          acceptanceCloseoutTarget: {
            exactHead: "targethead0000000000000000000000000001",
            artifactRef: "canonical-art",
          },
        },
      },
      interaction: {
        id: "ix",
        status: "accepted",
        payload: {
          ownerGuidance: {
            acceptanceLaneKey: "runtime_target_host",
            acceptanceLaneState: "not_applicable",
            recommendedDisposition: "runtime_not_applicable",
            exactHead: "decisionhead00000000000000000000000001",
            artifactRef: "decision-art",
          },
        },
        result: { outcome: "accepted" },
      },
    });
    expect(req).not.toBeNull();
    expect(req!.acceptedDecisionScope.exactHead).toBe("decisionhead00000000000000000000000001");
    expect(req!.currentTargetScope.exactHead).toBe("targethead0000000000000000000000000001");
    expect(req!.currentTargetScope.artifactRef).toBe("canonical-art");
    // Pure bind must refuse mismatch
    const bound = bindLaneTransitionIdempotent({}, req!);
    expect(bound.applied).toBe(false);
    expect(bound.code).toBe("refused_exact_head_mismatch");
  });

  it("liveness twin suppressed when source disposition can be repaired", () => {
    const r = shouldMintLivenessTwinHelper({
      sourceIssueStatus: "in_progress",
      sourceHasMissingDisposition: true,
      openTwinCount: 0,
    });
    expect(r.mint).toBe(false);
    expect(r.reason).toBe("repair_source_disposition_first");
  });

  it("liveness twin suppressed when open twin exists", () => {
    const r = shouldMintLivenessTwinHelper({
      sourceIssueStatus: "blocked",
      sourceHasMissingDisposition: false,
      openTwinCount: 1,
    });
    expect(r.mint).toBe(false);
    expect(r.reason).toBe("twin_already_open");
  });

  it("liveness twin allowed for genuine unrecoverable case", () => {
    const r = shouldMintLivenessTwinHelper({
      sourceIssueStatus: "blocked",
      sourceHasMissingDisposition: false,
      openTwinCount: 0,
      unrecoverable: true,
    });
    expect(r.mint).toBe(true);
  });

  it("extracts lane bind payload from ownerGuidance", () => {
    const partial = extractLaneBindFromInteractionPayload(
      {
        ownerGuidance: {
          acceptanceLaneKey: "runtime_target_host",
          acceptanceLaneState: "not_applicable",
          recommendedDisposition: "runtime_not_applicable",
          exactHead: "758457e",
        },
      },
      null,
    );
    expect(partial?.laneKey).toBe("runtime_target_host");
    expect(partial?.state).toBe("not_applicable");
  });

  it("parent becomes eligible when final controlling child is satisfied (pure blocker filter)", async () => {
    const { filterControllingBlockerIds } = await import("@paperclipai/shared");
    const before = filterControllingBlockerIds(
      ["child-a", "child-b"],
      { "child-a": "done", "child-b": "in_progress" },
    );
    expect(before.controlling).toEqual(["child-b"]);
    const after = filterControllingBlockerIds(
      ["child-a", "child-b"],
      { "child-a": "done", "child-b": "done" },
    );
    expect(after.controlling).toEqual([]);
    expect(after.satisfied).toEqual(["child-a", "child-b"]);
  });

  it("F2: pathClass from decision payload cannot self-assert standing-policy docs class", () => {
    const req = buildLaneBindingRequestFromPersisted({
      companyId: "co",
      issue: {
        id: "iss-1",
        executionState: {
          // no pathClass on trusted target
          acceptanceCloseoutTarget: {
            exactHead: "abc",
            artifactRef: "art",
          },
        },
      },
      interaction: {
        id: "ix",
        status: "accepted",
        payload: {
          ownerGuidance: {
            acceptanceLaneKey: "runtime_target_host",
            acceptanceLaneState: "not_applicable",
            recommendedDisposition: "runtime_not_applicable",
            pathClass: "documentation",
            standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
            exactHead: "abc",
          },
        },
        result: { outcome: "accepted" },
      },
    });
    expect(req).not.toBeNull();
    expect(req!.currentTargetScope.pathClass).toBeNull();
    expect(req!.acceptedDecisionScope.pathClass).toBe("documentation");
    // Standing policy with null trusted pathClass must refuse
    const bound = bindLaneTransitionIdempotent({}, {
      ...req!,
      standingPolicyId: STANDING_POLICY_DOCS_ONLY_RUNTIME_NA,
    });
    expect(bound.applied).toBe(false);
  });

  it("F3 production aggregation: later comment claim cannot override accepted runtime N/A", () => {
    const exec = {
      acceptanceLanes: {
        runtime_target_host: {
          state: "not_applicable",
          bindingInteractionId: "afdc7368",
          updatedAt: "2026-09-09T00:45:55.000Z",
        },
        independent_review: { state: "pending" },
      },
      acceptanceEvidenceClaims: [
        {
          source: "comment",
          laneKey: "runtime_target_host",
          claimedState: "pending",
          at: "2026-09-09T06:20:00.000Z",
          text: "runtime still required — reopen owner gate",
        },
      ],
    };
    const lanes = authoritativeAcceptanceLanesFromExecutionState(exec);
    expect(lanes.runtime_target_host?.state).toBe("not_applicable");
    expect(lanes.independent_review?.state).toBe("pending");
  });

  it("F4: recalculateParentGate flips parentEligible when controlling blockers clear", async () => {
    const store = new Map<string, any>([
      [
        "child-1",
        {
          id: "child-1",
          companyId: "co",
          status: "done",
          parentId: "parent-1",
          projectId: null,
          identifier: "PAP-CHILD",
          executionState: {
            acceptanceLanes: {
              runtime_target_host: { state: "not_applicable", bindingInteractionId: "ix" },
            },
          },
        },
      ],
      [
        "parent-1",
        {
          id: "parent-1",
          companyId: "co",
          status: "blocked",
          parentId: null,
          projectId: null,
          identifier: "PAP-PARENT",
          executionState: { concurrentKey: "keep-me" },
        },
      ],
    ]);

    // Call sequence for recalculateParentGate:
    // 1) loadIssue(child) -> limit
    // 2) listControllingBlockers: relations thenable
    // 3) listControllingBlockers: status rows thenable
    // 4) loadIssue(parent) -> limit
    // 5) FOR UPDATE execute
    // 6) locked parent select -> limit
    // 7) update parent
    let limitN = 0;
    let thenN = 0;
    const simpleDb: any = {
      execute: async () => undefined,
      select: () => {
        const chain: any = {
          from() { return chain; },
          where() { return chain; },
          limit: async () => {
            limitN += 1;
            if (limitN === 1) return [store.get("child-1")];
            return [store.get("parent-1")];
          },
          then(resolve: any, reject?: any) {
            thenN += 1;
            if (thenN === 1) {
              return Promise.resolve([{ blockerIssueId: "child-1" }]).then(resolve, reject);
            }
            // status of blockers — done => non-controlling
            return Promise.resolve([{ id: "child-1", status: "done" }]).then(resolve, reject);
          },
        };
        return chain;
      },
      update: () => ({
        set: (vals: any) => ({
          where: async () => {
            const parent = store.get("parent-1");
            parent.executionState = vals.executionState;
          },
        }),
      }),
    };

    const svc = createAcceptanceLaneService(simpleDb);
    const result = await svc.recalculateParentGate("co", "child-1");
    expect(result.parentId).toBe("parent-1");
    expect(result.parentEligible).toBe(true);
    expect(result.controllingBlockers).toEqual([]);
    expect(result.satisfiedBlockers).toEqual(["child-1"]);
    expect(store.get("parent-1").executionState.gateEligibility.parentEligible).toBe(true);
    expect(store.get("parent-1").executionState.concurrentKey).toBe("keep-me");
  });

  it("F5: assignmentPreflight fails closed when requiredCapabilities unspecified", async () => {
    let n = 0;
    const db: any = {
      select: () => {
        const chain: any = {
          from() { return chain; },
          where() { return chain; },
          limit: async () => {
            n += 1;
            if (n === 1) {
              return [{
                id: "ag-1",
                companyId: "co",
                status: "active",
                capabilities: "repo_write,dispatch",
                adapterType: "codex_local",
                pauseReason: null,
              }];
            }
            return [{
              id: "iss-1",
              companyId: "co",
              status: "todo",
              executionState: {},
              parentId: null,
              projectId: null,
              identifier: "PAP-X",
            }];
          },
        };
        return chain;
      },
    };
    const svc = createAcceptanceLaneService(db);
    const r = await svc.assignmentPreflight({
      companyId: "co",
      issueId: "iss-1",
      agentId: "ag-1",
    });
    expect(r.mayDispatch).toBe(false);
    expect(r.failures).toContain("required_capabilities_unspecified");
  });

  it("F5: assignmentPreflight passes when required capabilities granted", async () => {
    let n = 0;
    const db: any = {
      select: () => {
        const chain: any = {
          from() { return chain; },
          where() { return chain; },
          limit: async () => {
            n += 1;
            if (n === 1) {
              return [{
                id: "ag-1",
                companyId: "co",
                status: "active",
                capabilities: "repo_write,dispatch",
                adapterType: "codex_local",
                pauseReason: null,
              }];
            }
            return [{
              id: "iss-1",
              companyId: "co",
              status: "todo",
              executionState: { requiredCapabilities: ["repo_write"] },
              parentId: null,
              projectId: null,
              identifier: "PAP-X",
            }];
          },
        };
        return chain;
      },
    };
    const svc = createAcceptanceLaneService(db);
    const r = await svc.assignmentPreflight({
      companyId: "co",
      issueId: "iss-1",
      agentId: "ag-1",
    });
    expect(r.failures).toEqual([]);
    expect(r.mayDispatch).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("F1 writeAcceptanceLanesIntoExecutionState preserves concurrent keys on merge", () => {
    const written = writeAcceptanceLanesIntoExecutionState(
      { runtimeOwnedKey: "keep", acceptanceLanes: { old: { state: "pending" } } },
      { runtime_target_host: { state: "not_applicable", bindingInteractionId: "ix" } },
    );
    expect(written.runtimeOwnedKey).toBe("keep");
    expect((written.acceptanceLanes as any).runtime_target_host.state).toBe("not_applicable");
  });
});
