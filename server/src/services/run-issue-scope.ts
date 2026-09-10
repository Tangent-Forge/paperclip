/**
 * Execution ownership / issue-binding rules for heartbeat runs that attempt checkout.
 *
 * - Timer wakes may start unbound and later pick inbox work (checkout allowed).
 * - All other invocation sources must be issue-bound before checkout.
 * - When bound, the run issue id must match the checkout target.
 * - Wake binding must fail closed on contradictory issue identifiers.
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

export type BindIssueIdToWakeContextInput = {
  issueId?: string | null;
  payload?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
};

export type BindIssueIdToWakeContextResult =
  | {
      ok: true;
      payload: Record<string, unknown> | null;
      contextSnapshot: Record<string, unknown>;
      issueId: string | null;
    }
  | {
      ok: false;
      code: "contradictory_wake_issue_binding";
      message: string;
      details: {
        identifiers: Array<{ source: string; value: string }>;
      };
    };

function readNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const value = record[key];
  return typeof value === "string" ? readNonEmpty(value) : null;
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

  // Timer is the only invocation source allowed to checkout without an issue binding
  // (inbox pick-work). Assignment/on_demand/automation/manual/etc. must be bound.
  if (source === "timer") {
    return { ok: true };
  }

  if (!runIssueId) {
    return {
      ok: false,
      code: "unbound_on_demand_checkout_forbidden",
      message:
        "Unbound non-timer runs cannot checkout issue-scoped work. Pass payload.issueId (or top-level issueId) when waking for a specific issue.",
    };
  }

  return { ok: true };
}

/**
 * Normalize wake body so issue binding is consistent across top-level, payload,
 * and contextSnapshot. Conflicting non-empty identifiers fail closed.
 */
export function bindIssueIdToWakeContext(
  input: BindIssueIdToWakeContextInput,
): BindIssueIdToWakeContextResult {
  const identifiers: Array<{ source: string; value: string }> = [];
  const push = (source: string, value: string | null) => {
    if (value) identifiers.push({ source, value });
  };

  push("top-level.issueId", readNonEmpty(input.issueId ?? null));
  push("payload.issueId", readField(input.payload ?? null, "issueId"));
  push("payload.taskId", readField(input.payload ?? null, "taskId"));
  push("contextSnapshot.issueId", readField(input.contextSnapshot ?? null, "issueId"));
  push("contextSnapshot.taskId", readField(input.contextSnapshot ?? null, "taskId"));

  const distinct = [...new Set(identifiers.map((entry) => entry.value))];
  if (distinct.length > 1) {
    return {
      ok: false,
      code: "contradictory_wake_issue_binding",
      message:
        "Wake request contains contradictory issue bindings across issueId/taskId fields.",
      details: { identifiers },
    };
  }

  const issueId = distinct[0] ?? null;

  const payload =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? { ...input.payload }
      : {};
  const contextSnapshot =
    input.contextSnapshot &&
    typeof input.contextSnapshot === "object" &&
    !Array.isArray(input.contextSnapshot)
      ? { ...input.contextSnapshot }
      : {};

  if (issueId) {
    payload.issueId = issueId;
    if (!readField(payload, "taskId")) {
      // Keep legacy payload.taskId only when already present and matching; do not
      // invent taskId on payload unless caller already used that field.
    }
    contextSnapshot.issueId = issueId;
    contextSnapshot.taskId = issueId;
  }

  return {
    ok: true,
    payload: Object.keys(payload).length > 0 ? payload : input.payload ?? null,
    contextSnapshot,
    issueId,
  };
}
