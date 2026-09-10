/**
 * Execution ownership / issue-binding rules for heartbeat runs that attempt checkout.
 *
 * - Timer wakes may start unbound and later pick inbox work (checkout allowed).
 * - Assignment wakes are expected to carry issueId; if present it must match.
 * - On-demand and automation wakes intended for issue work must be issue-bound
 *   before checkout. An unbound on_demand/automation run fail-closes and cannot
 *   acquire issue-scoped work.
 */

export type RunCheckoutScopeInput = {
  invocationSource: string | null | undefined;
  runIssueId: string | null | undefined;
  targetIssueId: string;
};

export type RunCheckoutScopeResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "unbound_on_demand_checkout_forbidden"
        | "run_issue_scope_mismatch";
      message: string;
    };

function readNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function assertRunMayCheckoutIssue(input: RunCheckoutScopeInput): RunCheckoutScopeResult {
  const source = (input.invocationSource ?? "").trim() || "on_demand";
  const runIssueId = readNonEmpty(input.runIssueId);
  const targetIssueId = readNonEmpty(input.targetIssueId);
  if (!targetIssueId) {
    return {
      ok: false,
      code: "run_issue_scope_mismatch",
      message: "Checkout target issue id is required.",
    };
  }

  if (runIssueId && runIssueId !== targetIssueId) {
    return {
      ok: false,
      code: "run_issue_scope_mismatch",
      message: "This run is bound to a different issue and cannot checkout the requested issue.",
    };
  }

  // Timer (and legacy empty) may pick work unbound. Assignment without issueId is
  // unusual but not blocked here — assignment path normally always sets issueId.
  if (source === "timer") {
    return { ok: true };
  }

  if ((source === "on_demand" || source === "automation") && !runIssueId) {
    return {
      ok: false,
      code: "unbound_on_demand_checkout_forbidden",
      message:
        "Unbound on-demand/automation runs cannot checkout issue-scoped work. Pass payload.issueId (or top-level issueId) when waking for a specific issue.",
    };
  }

  return { ok: true };
}

/**
 * Normalize wake body so top-level issueId is always reflected in payload + snapshot.
 */
export function bindIssueIdToWakeContext(input: {
  issueId?: string | null;
  payload?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
}): {
  payload: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown>;
  issueId: string | null;
} {
  const fromTop = readNonEmpty(input.issueId ?? null);
  const fromPayload =
    readNonEmpty(
      typeof input.payload?.issueId === "string" ? input.payload.issueId : null,
    ) ??
    readNonEmpty(typeof input.payload?.taskId === "string" ? input.payload.taskId : null);
  const fromSnapshot =
    readNonEmpty(
      typeof input.contextSnapshot?.issueId === "string" ? input.contextSnapshot.issueId : null,
    ) ??
    readNonEmpty(
      typeof input.contextSnapshot?.taskId === "string" ? input.contextSnapshot.taskId : null,
    );
  const issueId = fromTop ?? fromPayload ?? fromSnapshot;

  const payload =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? { ...input.payload }
      : {};
  const contextSnapshot =
    input.contextSnapshot && typeof input.contextSnapshot === "object" && !Array.isArray(input.contextSnapshot)
      ? { ...input.contextSnapshot }
      : {};

  if (issueId) {
    if (!readNonEmpty(typeof payload.issueId === "string" ? payload.issueId : null)) {
      payload.issueId = issueId;
    }
    if (!readNonEmpty(typeof contextSnapshot.issueId === "string" ? contextSnapshot.issueId : null)) {
      contextSnapshot.issueId = issueId;
    }
    if (!readNonEmpty(typeof contextSnapshot.taskId === "string" ? contextSnapshot.taskId : null)) {
      contextSnapshot.taskId = issueId;
    }
  }

  return {
    payload: Object.keys(payload).length > 0 ? payload : input.payload ?? null,
    contextSnapshot,
    issueId,
  };
}
