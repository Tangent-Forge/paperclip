export type ExecutionQueueMode = "observe" | "controlled";

export type ExecutionQueueBucket = "runnable" | "waiting" | "blocked" | "held";

export type ExecutionQueueReason =
  | "ready"
  | "active_execution"
  | "queued_execution"
  | "agent_wip_limit"
  | "continuation_requires_recovery"
  | "explicit_blocker"
  | "unassigned"
  | "human_owned"
  | "agent_not_invokable"
  | "tree_hold"
  | "budget_blocked"
  | "company_inactive"
  | "backlog"
  | "review_or_approval";

export interface ExecutionQueueEntry {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeName: string | null;
  bucket: ExecutionQueueBucket;
  reason: ExecutionQueueReason;
  detail: string;
  updatedAt: string;
}

export interface ExecutionQueueSummary {
  companyId: string;
  mode: ExecutionQueueMode;
  maxActiveRunsPerAgent: number;
  generatedAt: string;
  counts: Record<ExecutionQueueBucket, number>;
  runnable: ExecutionQueueEntry[];
  waiting: ExecutionQueueEntry[];
  blocked: ExecutionQueueEntry[];
  held: ExecutionQueueEntry[];
}

export interface ExecutionQueueDispatchResult {
  // "selection_incomplete" means the scan hit its hard per-request bound
  // before either finding a dispatchable issue or exhausting the candidate
  // set — retryable, and distinct from "not_dispatched", which means the
  // scan ran to genuine exhaustion and found nothing runnable.
  disposition: "queued" | "not_dispatched" | "selection_incomplete";
  issueId: string | null;
  runId: string | null;
  reason: string;
}
