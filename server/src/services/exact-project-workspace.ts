/**
 * Exact project-workspace binding + automatic-attempt budget helpers.
 *
 * TAN-861 B0 / PAP-2915–2920 control-plane defects:
 * 1) Hermes provider no-ops must not persist as succeeded (adapter layer).
 * 2) Issue-selected projectWorkspaceId must bind exactly or fail closed —
 *    never fall through to project-primary or agent-home cwd.
 * 3) executionPolicy.retryCeiling is an aggregate automatic attempt budget
 *    across recovery, handoffs, requeues, and continuation. Operator wakes
 *    open a new epoch. retryCeiling=1 means at most one automatic attempt.
 * 4) Terminal success/verifier disposition must suppress automatic
 *    continuation and workspace-busy retry loops.
 */

export type ExactWorkspaceCandidate = {
  id: string;
  cwd: string | null | undefined;
  repoUrl?: string | null;
  repoRef?: string | null;
};

export type ExactWorkspaceResolution =
  | {
      ok: true;
      workspaceId: string;
      cwd: string;
      repoUrl: string | null;
      repoRef: string | null;
    }
  | {
      ok: false;
      reason: "workspace_unavailable";
      errorCode: "workspace_unavailable";
      requestedProjectWorkspaceId: string;
      detail:
        | "workspace_row_missing"
        | "workspace_path_missing"
        | "workspace_path_not_directory";
      requestedCwd: string | null;
      message: string;
    };

/**
 * Pure decision for issue-selected project workspace binding.
 * Callers supply whether the resolved cwd exists as a directory.
 */
export function resolveExactProjectWorkspace(input: {
  requestedProjectWorkspaceId: string | null | undefined;
  candidates: ExactWorkspaceCandidate[];
  /** Map of workspaceId -> whether its resolved local cwd exists as a directory. */
  cwdExistsByWorkspaceId: Record<string, boolean>;
  /** Optional resolved cwd override per workspace (managed checkout path). */
  resolvedCwdByWorkspaceId?: Record<string, string | null | undefined>;
  issueLabel?: string;
}): ExactWorkspaceResolution | { ok: true; unbound: true } {
  const requested = (input.requestedProjectWorkspaceId ?? "").trim();
  if (!requested) {
    return { ok: true, unbound: true };
  }

  const issueLabel = input.issueLabel ?? "issue";
  const row = input.candidates.find((c) => c.id === requested) ?? null;
  if (!row) {
    return {
      ok: false,
      reason: "workspace_unavailable",
      errorCode: "workspace_unavailable",
      requestedProjectWorkspaceId: requested,
      detail: "workspace_row_missing",
      requestedCwd: null,
      message: `Issue ${issueLabel} selected project workspace "${requested}", but that workspace is not available on this project. Failing closed without fallback cwd execution.`,
    };
  }

  const resolvedCwd =
    (input.resolvedCwdByWorkspaceId?.[row.id] ?? null) ||
    (typeof row.cwd === "string" ? row.cwd.trim() : "") ||
    null;

  if (!resolvedCwd) {
    return {
      ok: false,
      reason: "workspace_unavailable",
      errorCode: "workspace_unavailable",
      requestedProjectWorkspaceId: requested,
      detail: "workspace_path_missing",
      requestedCwd: null,
      message: `Issue ${issueLabel} selected project workspace "${requested}", but it has no local cwd configured. Failing closed without fallback cwd execution.`,
    };
  }

  if (!input.cwdExistsByWorkspaceId[row.id]) {
    return {
      ok: false,
      reason: "workspace_unavailable",
      errorCode: "workspace_unavailable",
      requestedProjectWorkspaceId: requested,
      detail: "workspace_path_not_directory",
      requestedCwd: resolvedCwd,
      message: `Issue ${issueLabel} selected project workspace "${requested}" at path "${resolvedCwd}", but that path is not available. Failing closed without fallback to project-primary or agent-home cwd.`,
    };
  }

  return {
    ok: true,
    workspaceId: row.id,
    cwd: resolvedCwd,
    repoUrl: row.repoUrl ?? null,
    repoRef: row.repoRef ?? null,
  };
}

export function readRetryCeilingFromExecutionPolicy(
  policy: unknown,
): number | null {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const raw = (policy as { retryCeiling?: unknown }).retryCeiling;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.floor(raw));
}

/** Wake sources that open a new operator epoch and bypass the automatic ceiling. */
export function classifyWakeBudgetSource(input: {
  source?: string | null;
  triggerDetail?: string | null;
  requestedByActorType?: string | null;
  wakeReason?: string | null;
  retryReason?: string | null;
}): "operator" | "automatic" {
  const actor = (input.requestedByActorType ?? "").toLowerCase();
  if (actor === "user" || actor === "board") return "operator";

  const trigger = (input.triggerDetail ?? "").toLowerCase();
  if (trigger === "manual" || trigger === "ping") return "operator";

  const source = (input.source ?? "").toLowerCase();
  if (source === "on_demand" && (trigger === "manual" || trigger === "ping" || actor === "user")) {
    return "operator";
  }

  // Explicit operator-ish wake reasons (board buttons / comment-driven human follow-up
  // still may be automatic when system-requested; only treat clear operator labels).
  const wakeReason = (input.wakeReason ?? "").toLowerCase();
  if (wakeReason === "manual" || wakeReason === "board_wakeup" || wakeReason === "operator") {
    return "operator";
  }

  return "automatic";
}

/**
 * Whether a historical/in-flight heartbeat run counts toward executionPolicy.retryCeiling.
 * Pure workspace-busy cancel-before-execute rows do not consume budget (same attempt deferred).
 */
export function runCountsTowardRetryCeiling(run: {
  status?: string | null;
  errorCode?: string | null;
  invocationSource?: string | null;
  scheduledRetryReason?: string | null;
}): boolean {
  const status = (run.status ?? "").toLowerCase();
  if (!status) return false;

  // Pure contention deferral cancelled before real execution does not consume budget.
  if (status === "cancelled") {
    const code = (run.errorCode ?? "").toLowerCase();
    if (code === "workspace_busy") return false;
    // Ownership/cancel races are not automatic attempts of the issue.
    if (code === "issue_reassigned" || code === "issue_cancelled") return false;
    return false;
  }

  // Live path and terminal outcomes count.
  if (
    status === "queued" ||
    status === "running" ||
    status === "scheduled_retry" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out"
  ) {
    return true;
  }

  return false;
}

export function countAutomaticAttemptsTowardCeiling(
  runs: Array<{
    status?: string | null;
    errorCode?: string | null;
    invocationSource?: string | null;
    scheduledRetryReason?: string | null;
  }>,
): number {
  let n = 0;
  for (const run of runs) {
    if (runCountsTowardRetryCeiling(run)) n += 1;
  }
  return n;
}

/**
 * Whether automatic follow-on starts should be suppressed after a terminal
 * verifier/success disposition or exhausted retry ceiling.
 */
export function shouldSuppressAutomaticContinuation(input: {
  issueStatus?: string | null;
  terminalDispositionRecorded?: boolean;
  verifierPassed?: boolean;
  automaticAttemptsUsed?: number;
  retryCeiling?: number | null;
  /** workspace_busy deferral of the same attempt: ignore ceiling, still honor terminal status. */
  kind?: "new_attempt" | "deferral_retry";
}): { suppress: boolean; reason: string | null } {
  const status = (input.issueStatus ?? "").toLowerCase();
  if (status === "done" || status === "cancelled" || status === "backlog") {
    return { suppress: true, reason: `issue_status_${status || "unknown"}` };
  }
  if (input.terminalDispositionRecorded) {
    return { suppress: true, reason: "terminal_disposition_recorded" };
  }
  if (input.verifierPassed) {
    return { suppress: true, reason: "verifier_passed" };
  }

  if (input.kind === "deferral_retry") {
    return { suppress: false, reason: null };
  }

  const ceiling = input.retryCeiling;
  if (typeof ceiling === "number" && ceiling >= 0) {
    const used = input.automaticAttemptsUsed ?? 0;
    if (used >= ceiling) {
      return { suppress: true, reason: "retry_ceiling_exhausted" };
    }
  }
  return { suppress: false, reason: null };
}

/**
 * Aggregate automatic-attempt budget.
 * retryCeiling=1 means at most one total automatic execution attempt unless a
 * new operator policy epoch is established.
 */
export function evaluateRetryCeiling(input: {
  retryCeiling?: number | null;
  automaticAttemptsUsed: number;
  source: "assignment" | "automation" | "operator" | "manual" | "board" | string;
  kind?: "new_attempt" | "deferral_retry";
}): { allowed: boolean; reason: string | null; used: number; ceiling: number | null } {
  const ceiling =
    typeof input.retryCeiling === "number" && Number.isFinite(input.retryCeiling)
      ? Math.max(0, Math.floor(input.retryCeiling))
      : null;

  // Operator/manual wakes establish a new epoch and are not blocked by ceiling.
  if (input.source === "operator" || input.source === "manual" || input.source === "board") {
    return { allowed: true, reason: null, used: input.automaticAttemptsUsed, ceiling };
  }

  // Same-attempt workspace_busy deferral does not consume a new budget slot.
  if (input.kind === "deferral_retry") {
    return { allowed: true, reason: null, used: input.automaticAttemptsUsed, ceiling };
  }

  if (ceiling === null) {
    return { allowed: true, reason: null, used: input.automaticAttemptsUsed, ceiling: null };
  }

  if (input.automaticAttemptsUsed >= ceiling) {
    return {
      allowed: false,
      reason: "retry_ceiling_exhausted",
      used: input.automaticAttemptsUsed,
      ceiling,
    };
  }

  return { allowed: true, reason: null, used: input.automaticAttemptsUsed, ceiling };
}

/**
 * Combined gate used by enqueueWakeup / scheduleBoundedRetry call sites.
 */
export function evaluateAutomaticExecutionGate(input: {
  issueStatus?: string | null;
  executionPolicy?: unknown;
  automaticAttemptsUsed: number;
  wakeBudgetSource: "operator" | "automatic" | string;
  kind?: "new_attempt" | "deferral_retry";
  terminalDispositionRecorded?: boolean;
  verifierPassed?: boolean;
}): {
  allowed: boolean;
  reason: string | null;
  retryCeiling: number | null;
  used: number;
} {
  const retryCeiling = readRetryCeilingFromExecutionPolicy(input.executionPolicy);
  const kind = input.kind ?? "new_attempt";

  if (input.wakeBudgetSource === "operator" || input.wakeBudgetSource === "manual" || input.wakeBudgetSource === "board") {
    // Operators may wake even when backlog/done; board intentionally unblocks.
    // Still block pure automatic thrash only — operator path returns allowed.
    return { allowed: true, reason: null, retryCeiling, used: input.automaticAttemptsUsed };
  }

  const suppress = shouldSuppressAutomaticContinuation({
    issueStatus: input.issueStatus,
    terminalDispositionRecorded: input.terminalDispositionRecorded,
    verifierPassed: input.verifierPassed,
    automaticAttemptsUsed: input.automaticAttemptsUsed,
    retryCeiling,
    kind,
  });
  if (suppress.suppress) {
    return {
      allowed: false,
      reason: suppress.reason,
      retryCeiling,
      used: input.automaticAttemptsUsed,
    };
  }

  const ceiling = evaluateRetryCeiling({
    retryCeiling,
    automaticAttemptsUsed: input.automaticAttemptsUsed,
    source: input.wakeBudgetSource === "automatic" ? "automation" : input.wakeBudgetSource,
    kind,
  });
  if (!ceiling.allowed) {
    return {
      allowed: false,
      reason: ceiling.reason,
      retryCeiling: ceiling.ceiling,
      used: ceiling.used,
    };
  }

  return {
    allowed: true,
    reason: null,
    retryCeiling: ceiling.ceiling,
    used: ceiling.used,
  };
}
