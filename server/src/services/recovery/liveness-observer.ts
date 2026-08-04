import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { RECOVERY_ORIGIN_KINDS } from "./origins.js";
import { classifyIssueGraphLiveness, type IssueLivenessFinding } from "./issue-graph-liveness.js";

export type LivenessCanonicalFinding = IssueLivenessFinding & {
  canonicalSourceProvider: string;
  canonicalSourceOriginId: string;
};

const RECOVERY_ORIGIN_KIND_SET = new Set(Object.values(RECOVERY_ORIGIN_KINDS));

export function canonicalizeIssueIdentity(issue: {
  id: string;
  originKind: string | null;
  originId: string | null;
}) {
  if (issue.originKind && issue.originKind !== "manual" && issue.originId) {
    return { canonicalSourceProvider: issue.originKind, canonicalSourceOriginId: issue.originId };
  }
  return { canonicalSourceProvider: "paperclip:issue", canonicalSourceOriginId: issue.id };
}

export async function observeIssueGraphLiveness(db: Db, opts?: { now?: Date }) {
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      createdByAgentId: issues.createdByAgentId,
      createdByUserId: issues.createdByUserId,
      executionState: issues.executionState,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(and(isNull(issues.hiddenAt), notInArray(issues.originKind, [...RECOVERY_ORIGIN_KIND_SET])))
    .orderBy(issues.companyId, issues.id);

  const findings = classifyIssueGraphLiveness({
    now: opts?.now,
    issues: rows,
    relations: [],
    agents: [],
    activeRuns: [],
    queuedWakeRequests: [],
    pendingInteractions: [],
    pendingApprovals: [],
    openRecoveryIssues: [],
  }).map((finding) => {
    const issue = rows.find((row) => row.id === finding.issueId)!;
    const canonical = canonicalizeIssueIdentity(issue);
    return { ...finding, ...canonical };
  });

  const deduped = new Map<string, LivenessCanonicalFinding>();
  for (const finding of findings) {
    const key = `${finding.companyId}:${finding.canonicalSourceProvider}:${finding.canonicalSourceOriginId}:${finding.state}`;
    if (!deduped.has(key)) deduped.set(key, finding);
  }
  return [...deduped.values()];
}
