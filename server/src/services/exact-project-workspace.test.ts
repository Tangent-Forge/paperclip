import { describe, expect, it } from "vitest";
import {
  classifyWakeBudgetSource,
  countAutomaticAttemptsTowardCeiling,
  evaluateAutomaticExecutionGate,
  evaluateRetryCeiling,
  readCanonicalExecutionContinuationSignals,
  readRetryCeilingFromExecutionPolicy,
  resolveExactProjectWorkspace,
  runCountsTowardRetryCeiling,
  shouldScheduleProviderQuotaRecoveryMonitor,
  shouldSuppressAutomaticContinuation,
} from "./exact-project-workspace.js";

describe("resolveExactProjectWorkspace", () => {
  const candidates = [
    { id: "primary", cwd: "/proj/primary", repoUrl: null, repoRef: null },
    { id: "missing", cwd: "/proj/INTENTIONALLY_ABSENT", repoUrl: null, repoRef: null },
    { id: "good", cwd: "/proj/good", repoUrl: null, repoRef: null },
  ];

  it("is unbound when no projectWorkspaceId is selected", () => {
    const r = resolveExactProjectWorkspace({
      requestedProjectWorkspaceId: null,
      candidates,
      cwdExistsByWorkspaceId: { primary: true, missing: false, good: true },
    });
    expect(r).toEqual({ ok: true, unbound: true });
  });

  it("fails closed when selected workspace row is missing", () => {
    const r = resolveExactProjectWorkspace({
      requestedProjectWorkspaceId: "ghost",
      candidates,
      cwdExistsByWorkspaceId: {},
      issueLabel: "PAP-2917",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("workspace_unavailable");
    expect(r.detail).toBe("workspace_row_missing");
    expect(r.message).toContain("PAP-2917");
    expect(r.message).toMatch(/without fallback/i);
  });

  it("fails closed when selected path is absent and does not bind primary", () => {
    const r = resolveExactProjectWorkspace({
      requestedProjectWorkspaceId: "missing",
      candidates,
      cwdExistsByWorkspaceId: { primary: true, missing: false, good: true },
      issueLabel: "PAP-2917",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("workspace_unavailable");
    expect(r.detail).toBe("workspace_path_not_directory");
    expect(r.requestedCwd).toBe("/proj/INTENTIONALLY_ABSENT");
    expect(r.requestedProjectWorkspaceId).toBe("missing");
    // Must not silently return primary
    expect(JSON.stringify(r)).not.toContain("/proj/primary");
  });

  it("binds only the exact selected workspace when present", () => {
    const r = resolveExactProjectWorkspace({
      requestedProjectWorkspaceId: "good",
      candidates,
      cwdExistsByWorkspaceId: { primary: true, missing: false, good: true },
    });
    expect(r).toEqual({
      ok: true,
      workspaceId: "good",
      cwd: "/proj/good",
      repoUrl: null,
      repoRef: null,
    });
  });
});

describe("evaluateRetryCeiling", () => {
  it("allows operator wakes even when ceiling is exhausted", () => {
    const r = evaluateRetryCeiling({
      retryCeiling: 1,
      automaticAttemptsUsed: 5,
      source: "operator",
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks automation once used >= ceiling", () => {
    const r = evaluateRetryCeiling({
      retryCeiling: 1,
      automaticAttemptsUsed: 1,
      source: "automation",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("retry_ceiling_exhausted");
  });

  it("allows the first automatic attempt when ceiling=1", () => {
    const r = evaluateRetryCeiling({
      retryCeiling: 1,
      automaticAttemptsUsed: 0,
      source: "assignment",
    });
    expect(r.allowed).toBe(true);
  });

  it("does not apply ceiling to same-attempt workspace_busy deferral", () => {
    const r = evaluateRetryCeiling({
      retryCeiling: 1,
      automaticAttemptsUsed: 1,
      source: "automation",
      kind: "deferral_retry",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("shouldSuppressAutomaticContinuation", () => {
  it("suppresses when issue is backlog/done or terminal disposition is set", () => {
    expect(shouldSuppressAutomaticContinuation({ issueStatus: "backlog" }).suppress).toBe(true);
    expect(shouldSuppressAutomaticContinuation({ issueStatus: "done" }).suppress).toBe(true);
    expect(
      shouldSuppressAutomaticContinuation({ terminalDispositionRecorded: true }).suppress,
    ).toBe(true);
    expect(shouldSuppressAutomaticContinuation({ verifierPassed: true }).suppress).toBe(true);
  });

  it("suppresses when retry ceiling is exhausted", () => {
    const r = shouldSuppressAutomaticContinuation({
      issueStatus: "in_progress",
      automaticAttemptsUsed: 2,
      retryCeiling: 1,
    });
    expect(r.suppress).toBe(true);
    expect(r.reason).toBe("retry_ceiling_exhausted");
  });

  it("does not suppress an open in-progress issue under budget", () => {
    const r = shouldSuppressAutomaticContinuation({
      issueStatus: "in_progress",
      automaticAttemptsUsed: 0,
      retryCeiling: 1,
    });
    expect(r.suppress).toBe(false);
  });

  it("still suppresses done issues for workspace_busy deferral retries", () => {
    const r = shouldSuppressAutomaticContinuation({
      issueStatus: "done",
      kind: "deferral_retry",
      automaticAttemptsUsed: 0,
      retryCeiling: 1,
    });
    expect(r.suppress).toBe(true);
    expect(r.reason).toBe("issue_status_done");
  });

  it("allows workspace_busy deferral under ceiling while in_progress", () => {
    const r = shouldSuppressAutomaticContinuation({
      issueStatus: "in_progress",
      kind: "deferral_retry",
      automaticAttemptsUsed: 5,
      retryCeiling: 1,
    });
    expect(r.suppress).toBe(false);
  });
});

describe("run counting + wake source classification", () => {
  it("does not count workspace_busy cancellations toward the ceiling", () => {
    expect(
      runCountsTowardRetryCeiling({ status: "cancelled", errorCode: "workspace_busy" }),
    ).toBe(false);
    expect(runCountsTowardRetryCeiling({ status: "succeeded", invocationSource: "automation" })).toBe(
      true,
    );
    expect(runCountsTowardRetryCeiling({ status: "failed", invocationSource: "assignment" })).toBe(
      true,
    );
    expect(runCountsTowardRetryCeiling({ status: "queued", invocationSource: "automation" })).toBe(
      true,
    );
  });

  it("does not count operator/manual epoch runs toward the automatic ceiling", () => {
    expect(
      runCountsTowardRetryCeiling({
        status: "succeeded",
        invocationSource: "manual",
        triggerDetail: "manual",
      }),
    ).toBe(false);
    expect(
      runCountsTowardRetryCeiling({
        status: "failed",
        invocationSource: "on_demand",
        triggerDetail: "manual",
        requestedByActorType: "user",
      }),
    ).toBe(false);
    expect(
      runCountsTowardRetryCeiling({
        status: "succeeded",
        invocationSource: "on_demand",
        triggerDetail: "ping",
      }),
    ).toBe(false);
    // Automatic epochs still count even when mixed with operator history.
    expect(
      runCountsTowardRetryCeiling({
        status: "failed",
        invocationSource: "automation",
        triggerDetail: "system",
      }),
    ).toBe(true);
  });

  it("uses invocationSource (does not ignore it) when deciding ceiling budget", () => {
    // Same terminal status — only the source distinguishes operator vs automatic.
    const automatic = runCountsTowardRetryCeiling({
      status: "failed",
      invocationSource: "automation",
      triggerDetail: "system",
    });
    const operatorManual = runCountsTowardRetryCeiling({
      status: "failed",
      invocationSource: "manual",
      triggerDetail: "system",
    });
    const boardOnDemandManual = runCountsTowardRetryCeiling({
      status: "failed",
      invocationSource: "on_demand",
      triggerDetail: "manual",
    });
    expect(automatic).toBe(true);
    expect(operatorManual).toBe(false);
    expect(boardOnDemandManual).toBe(false);
    expect(classifyWakeBudgetSource({ source: "manual" })).toBe("operator");
    expect(classifyWakeBudgetSource({ source: "on_demand", triggerDetail: "manual" })).toBe(
      "operator",
    );
    expect(classifyWakeBudgetSource({ source: "automation", triggerDetail: "system" })).toBe(
      "automatic",
    );
  });

  it("counts only budget-consuming automatic runs", () => {
    const n = countAutomaticAttemptsTowardCeiling([
      { status: "succeeded", invocationSource: "automation" },
      { status: "cancelled", errorCode: "workspace_busy", invocationSource: "automation" },
      { status: "failed", invocationSource: "assignment" },
      { status: "cancelled", errorCode: "issue_reassigned", invocationSource: "automation" },
      { status: "succeeded", invocationSource: "manual", triggerDetail: "manual" },
      {
        status: "failed",
        invocationSource: "on_demand",
        triggerDetail: "manual",
        requestedByActorType: "user",
      },
    ]);
    expect(n).toBe(2);
  });

  it("classifies manual/user wakes as operator", () => {
    expect(
      classifyWakeBudgetSource({
        source: "on_demand",
        triggerDetail: "manual",
        requestedByActorType: "user",
      }),
    ).toBe("operator");
    expect(classifyWakeBudgetSource({ source: "automation", triggerDetail: "system" })).toBe(
      "automatic",
    );
    expect(classifyWakeBudgetSource({ source: "assignment", triggerDetail: "system" })).toBe(
      "automatic",
    );
  });

  it("reads retryCeiling from execution policy objects", () => {
    expect(readRetryCeilingFromExecutionPolicy({ retryCeiling: 1 })).toBe(1);
    expect(readRetryCeilingFromExecutionPolicy({ retryCeiling: 1.9 })).toBe(1);
    expect(readRetryCeilingFromExecutionPolicy(null)).toBe(null);
  });
});

describe("canonical executionState terminal/verifier signals", () => {
  it("maps status completed + lastDecisionOutcome approved to terminal+verifier", () => {
    const signals = readCanonicalExecutionContinuationSignals({
      status: "completed",
      currentStageId: null,
      lastDecisionOutcome: "approved",
      completedStageIds: ["stage-1"],
    });
    expect(signals.terminalDispositionRecorded).toBe(true);
    expect(signals.verifierPassed).toBe(true);
    expect(signals.status).toBe("completed");
    expect(signals.lastDecisionOutcome).toBe("approved");
  });

  it("treats completed without outcome as terminal disposition but not verifier pass", () => {
    const signals = readCanonicalExecutionContinuationSignals({
      status: "completed",
      lastDecisionOutcome: null,
    });
    expect(signals.terminalDispositionRecorded).toBe(true);
    // buildCompletedState always stamps lastDecisionOutcome "approved"; a completed
    // state without it is non-canonical and must not read as verifier-passed.
    expect(signals.verifierPassed).toBe(false);
  });

  it("does not suppress pending stages that merely retain a prior approved outcome", () => {
    const signals = readCanonicalExecutionContinuationSignals({
      status: "pending",
      currentStageId: "stage-2",
      lastDecisionOutcome: "approved",
    });
    expect(signals.terminalDispositionRecorded).toBe(false);
    expect(signals.verifierPassed).toBe(false);
  });

  it("still accepts legacy synthetic terminal/verifier fields", () => {
    expect(
      readCanonicalExecutionContinuationSignals({
        status: "terminal",
        verifierPassed: true,
      }),
    ).toMatchObject({ terminalDispositionRecorded: true, verifierPassed: true });
  });

  it("feeds evaluateAutomaticExecutionGate with canonical completed/approved", () => {
    const signals = readCanonicalExecutionContinuationSignals({
      status: "completed",
      lastDecisionOutcome: "approved",
    });
    const r = evaluateAutomaticExecutionGate({
      issueStatus: "in_progress",
      executionPolicy: { retryCeiling: 3 },
      automaticAttemptsUsed: 0,
      wakeBudgetSource: "automatic",
      terminalDispositionRecorded: signals.terminalDispositionRecorded,
      verifierPassed: signals.verifierPassed,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason === "terminal_disposition_recorded" || r.reason === "verifier_passed").toBe(
      true,
    );
  });
});

describe("provider-quota direct scheduled_retry insert gate", () => {
  it("blocks residual provider-quota scheduled_retry after ceiling exhaustion", () => {
    const r = shouldScheduleProviderQuotaRecoveryMonitor({
      issueStatus: "blocked",
      executionPolicy: { retryCeiling: 1 },
      executionState: { status: "pending", lastDecisionOutcome: null },
      automaticAttemptsUsed: 1,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("retry_ceiling_exhausted");
  });

  it("blocks provider-quota residual after canonical completed/approved disposition", () => {
    const r = shouldScheduleProviderQuotaRecoveryMonitor({
      issueStatus: "in_progress",
      executionPolicy: { retryCeiling: 5 },
      executionState: {
        status: "completed",
        lastDecisionOutcome: "approved",
        completedStageIds: ["review"],
      },
      automaticAttemptsUsed: 0,
    });
    expect(r.allowed).toBe(false);
  });

  it("allows first automatic provider-quota monitor under budget", () => {
    const r = shouldScheduleProviderQuotaRecoveryMonitor({
      issueStatus: "blocked",
      executionPolicy: { retryCeiling: 1 },
      executionState: { status: "pending", lastDecisionOutcome: null },
      automaticAttemptsUsed: 0,
    });
    expect(r.allowed).toBe(true);
  });

  it("matches buildCompletedState shape (status completed + lastDecisionOutcome approved)", () => {
    // Mirrors issue-execution-policy buildCompletedState fields used live.
    const buildCompletedStateShape = {
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: ["stage-1"],
      lastDecisionId: "dec-1",
      lastDecisionOutcome: "approved",
      monitor: null,
      changesRequestedCount: 0,
    };
    const signals = readCanonicalExecutionContinuationSignals(buildCompletedStateShape);
    expect(signals.terminalDispositionRecorded).toBe(true);
    expect(signals.verifierPassed).toBe(true);
    const gate = shouldScheduleProviderQuotaRecoveryMonitor({
      issueStatus: "in_progress",
      executionPolicy: { retryCeiling: 3 },
      executionState: buildCompletedStateShape,
      automaticAttemptsUsed: 0,
    });
    expect(gate.allowed).toBe(false);
  });
});

describe("evaluateAutomaticExecutionGate (combined chokepoint)", () => {
  it("blocks second automatic start when retryCeiling=1 and one attempt used", () => {
    const r = evaluateAutomaticExecutionGate({
      issueStatus: "in_progress",
      executionPolicy: { retryCeiling: 1 },
      automaticAttemptsUsed: 1,
      wakeBudgetSource: "automatic",
      kind: "new_attempt",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("retry_ceiling_exhausted");
  });

  it("allows first automatic start", () => {
    const r = evaluateAutomaticExecutionGate({
      issueStatus: "todo",
      executionPolicy: { retryCeiling: 1 },
      automaticAttemptsUsed: 0,
      wakeBudgetSource: "automatic",
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks automatic recovery after done + verifier", () => {
    const r = evaluateAutomaticExecutionGate({
      issueStatus: "done",
      executionPolicy: { retryCeiling: 3 },
      automaticAttemptsUsed: 0,
      wakeBudgetSource: "automatic",
      verifierPassed: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("issue_status_done");
  });

  it("allows operator wake after ceiling exhaustion", () => {
    const r = evaluateAutomaticExecutionGate({
      issueStatus: "blocked",
      executionPolicy: { retryCeiling: 1 },
      automaticAttemptsUsed: 4,
      wakeBudgetSource: "operator",
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks workspace_busy loop after issue is done", () => {
    const r = evaluateAutomaticExecutionGate({
      issueStatus: "done",
      executionPolicy: { retryCeiling: 1 },
      automaticAttemptsUsed: 1,
      wakeBudgetSource: "automatic",
      kind: "deferral_retry",
    });
    expect(r.allowed).toBe(false);
  });

  it("allows workspace_busy deferral while in_progress even if ceiling would block new attempts", () => {
    const r = evaluateAutomaticExecutionGate({
      issueStatus: "in_progress",
      executionPolicy: { retryCeiling: 1 },
      automaticAttemptsUsed: 1,
      wakeBudgetSource: "automatic",
      kind: "deferral_retry",
    });
    expect(r.allowed).toBe(true);
  });
});
