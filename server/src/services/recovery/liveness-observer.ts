import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { RECOVERY_ORIGIN_KINDS } from "./origins.js";
import { classifyIssueGraphLiveness, type IssueLivenessFinding } from "./issue-graph-liveness.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const RECOVERY_ORIGINS = Object.values(RECOVERY_ORIGIN_KINDS);
const WAKE_CONTEXT_KEY = "_paperclipWakeContext";

export type CanonicalLivenessFinding = IssueLivenessFinding & {
  sourceProvider: string;
  sourceOriginId: string;
  incidentClass: "issue_graph_liveness";
  canonicalIdentity: { companyId: string; provider: string; originId: string; incidentClass: "issue_graph_liveness" };
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function issueIdFromRunContext(value: unknown) {
  const context = parseObject(value);
  return text(context.issueId) ?? text(context.taskId);
}

function issueIdFromWakePayload(value: unknown) {
  const parsed = parseObject(value);
  const nested = parseObject(parsed[WAKE_CONTEXT_KEY]);
  return text(parsed.issueId) ?? text(nested.issueId) ?? text(nested.taskId);
}

export function isRecoveryOriginKind(originKind: string | null) {
  return originKind !== null && RECOVERY_ORIGINS.includes(originKind as (typeof RECOVERY_ORIGINS)[number]);
}

export function canonicalLivenessSourceIdentity(issue: { companyId: string; id: string; originKind: string | null; originId: string | null }) {
  const plugin = issue.originKind !== null && issue.originId !== null;
  return {
    companyId: issue.companyId,
    provider: plugin ? issue.originKind! : "paperclip:issue",
    originId: plugin ? issue.originId! : issue.id,
    incidentClass: "issue_graph_liveness" as const,
  };
}

function findingKey(finding: IssueLivenessFinding, provider: string, originId: string) {
  return `${finding.companyId}\0${provider}\0${originId}\0${finding.state}\0${finding.recoveryIssueId}`;
}

function severityRank(severity: IssueLivenessFinding["severity"]) {
  return severity === "critical" ? 0 : 1;
}

function evidenceOrder(left: CanonicalLivenessFinding, right: CanonicalLivenessFinding) {
  return severityRank(left.severity) - severityRank(right.severity) ||
    left.reason.localeCompare(right.reason) ||
    left.issueId.localeCompare(right.issueId) ||
    left.incidentKey.localeCompare(right.incidentKey);
}

/** Read-only graph projection. Keep service imports out of this module. */
export async function observeIssueGraphLiveness(db: Db, now = new Date()): Promise<CanonicalLivenessFinding[]> {
  const candidateFilter = and(
    isNull(issues.hiddenAt),
    or(isNull(issues.originKind), sql`${issues.originKind} not in ${sql.raw(`(${RECOVERY_ORIGINS.map((v) => `'${v}'`).join(",")})`)}`),
  );
  const issueRowsPromise = db.select({
    id: issues.id, companyId: issues.companyId, identifier: issues.identifier, title: issues.title,
    status: issues.status, projectId: issues.projectId, goalId: issues.goalId, parentId: issues.parentId,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
    createdByAgentId: issues.createdByAgentId, createdByUserId: issues.createdByUserId,
    originKind: issues.originKind, originId: issues.originId,
    executionPolicy: issues.executionPolicy, executionState: issues.executionState,
    monitorNextCheckAt: issues.monitorNextCheckAt, monitorAttemptCount: issues.monitorAttemptCount,
  }).from(issues).where(candidateFilter);
  const [issueRows, relationRows, agentRows, activeRunRows, activeIssueRunRows, wakeRows, interactionRows, approvalRows, recoveryRows, actionRows] = await Promise.all([
    issueRowsPromise,
    db.select({ companyId: issueRelations.companyId, blockerIssueId: issueRelations.issueId, blockedIssueId: issueRelations.relatedIssueId }).from(issueRelations).where(eq(issueRelations.type, "blocks")),
    db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, role: agents.role, title: agents.title, status: agents.status, reportsTo: agents.reportsTo }).from(agents),
    db.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES])),
    db.select({ companyId: issues.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, issueId: issues.id }).from(issues).innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id)).where(and(candidateFilter, inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]))),
    db.select({ companyId: agentWakeupRequests.companyId, agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status, payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])),
    db.select({ companyId: issueThreadInteractions.companyId, issueId: issueThreadInteractions.issueId, status: issueThreadInteractions.status }).from(issueThreadInteractions).where(eq(issueThreadInteractions.status, "pending")),
    db.select({ companyId: issueApprovals.companyId, issueId: issueApprovals.issueId, status: approvals.status }).from(issueApprovals).innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id)).where(inArray(approvals.status, ["pending", "revision_requested"])),
    db.select({ companyId: issues.companyId, id: issues.id, status: issues.status, originKind: issues.originKind, originId: issues.originId }).from(issues).where(and(isNull(issues.hiddenAt), inArray(issues.originKind, [...RECOVERY_ORIGINS]), sql`${issues.status} not in ('done','cancelled')`)),
    issueRowsPromise.then((rows) => rows.length === 0 ? [] : db.select({ companyId: issueRecoveryActions.companyId, issueId: issueRecoveryActions.sourceIssueId, status: issueRecoveryActions.status }).from(issueRecoveryActions).where(and(inArray(issueRecoveryActions.status, ["active", "escalated"]), inArray(issueRecoveryActions.sourceIssueId, rows.map((row) => row.id))))),
  ]);
  const openRecoveryIssues = recoveryRows.flatMap((row) => {
    const originId = text(row.originId);
    return originId ? [{ companyId: row.companyId, issueId: originId, status: row.status }] : [];
  });
  const findings = classifyIssueGraphLiveness({
    issues: issueRows,
    relations: relationRows,
    agents: agentRows,
    activeRuns: activeRunRows.map((row) => ({ companyId: row.companyId, agentId: row.agentId, status: row.status, issueId: issueIdFromRunContext(row.contextSnapshot) })).concat(activeIssueRunRows),
    queuedWakeRequests: wakeRows.map((row) => ({ companyId: row.companyId, agentId: row.agentId, status: row.status, issueId: issueIdFromWakePayload(row.payload) })),
    pendingInteractions: interactionRows,
    pendingApprovals: approvalRows,
    openRecoveryIssues: openRecoveryIssues.concat(actionRows),
    now,
  });
  const issueById = new Map(issueRows.map((row) => [row.id, row]));
  const deduped = new Map<string, CanonicalLivenessFinding>();
  for (const finding of findings) {
    const source = issueById.get(finding.issueId);
    if (!source || isRecoveryOriginKind(source.originKind)) continue;
    const identity = canonicalLivenessSourceIdentity(source);
    const canonical: CanonicalLivenessFinding = { ...finding, sourceProvider: identity.provider, sourceOriginId: identity.originId, incidentClass: "issue_graph_liveness", canonicalIdentity: identity };
    const key = findingKey(finding, identity.provider, identity.originId);
    const previous = deduped.get(key);
    if (!previous || evidenceOrder(canonical, previous) < 0) deduped.set(key, canonical);
  }
  return [...deduped.values()].sort((a, b) => a.companyId.localeCompare(b.companyId) || a.sourceProvider.localeCompare(b.sourceProvider) || a.sourceOriginId.localeCompare(b.sourceOriginId) || evidenceOrder(a, b));
}
