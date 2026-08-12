import {
  isPaperclipLocalIssueOriginKind,
  PAPERCLIP_LOCAL_ISSUE_PREFIX,
} from "./constants.js";

export type IssueIdentifierRow = {
  id: string;
  companyId: string;
  identifier: string;
  issueNumber: number;
  originKind: string;
};

export type IdentifierBackfillChange = IssueIdentifierRow & {
  targetIdentifier: string;
};

export type IdentifierBackfillCollision = {
  targetIdentifier: string;
  candidateId: string;
  existingId: string;
};

export function buildIdentifierBackfillPlan(
  rows: IssueIdentifierRow[],
  options: { sourcePrefix?: string } = {},
): {
  changes: IdentifierBackfillChange[];
  collisions: IdentifierBackfillCollision[];
} {
  const byIdentifier = new Map(rows.map((row) => [row.identifier, row]));
  const changes = rows
    .filter((row) => isPaperclipLocalIssueOriginKind(row.originKind))
    .filter((row) => (
      options.sourcePrefix
        ? row.identifier.startsWith(`${options.sourcePrefix}-`)
        : true
    ))
    .map((row) => ({
      ...row,
      targetIdentifier: `${PAPERCLIP_LOCAL_ISSUE_PREFIX}-${row.issueNumber}`,
    }))
    .filter((row) => row.identifier !== row.targetIdentifier);
  const collisions = changes.flatMap((change) => {
    const existing = byIdentifier.get(change.targetIdentifier);
    const conflicts: IdentifierBackfillCollision[] = [];
    if (existing && existing.id !== change.id) {
      conflicts.push({
        targetIdentifier: change.targetIdentifier,
        candidateId: change.id,
        existingId: existing.id,
      });
    }
    const duplicateCandidate = changes.find(
      (candidate) => (
        candidate.id !== change.id
        && candidate.targetIdentifier === change.targetIdentifier
      ),
    );
    if (duplicateCandidate && change.id < duplicateCandidate.id) {
      conflicts.push({
        targetIdentifier: change.targetIdentifier,
        candidateId: change.id,
        existingId: duplicateCandidate.id,
      });
    }
    return conflicts;
  });
  return { changes, collisions };
}
