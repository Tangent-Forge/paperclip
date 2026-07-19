import type {
  NormalizedPortfolioIssue,
  NormalizedPortfolioProject,
  NormalizedPortfolioRecord,
  PortfolioExecutionTruth,
  PortfolioInventoryIssue,
  PortfolioInventoryProject,
  PortfolioInventorySnapshot,
  PortfolioInventorySourceMeta,
  PortfolioInventoryTruth,
} from "./portfolio-types.js";
import type { LinearClient } from "./linear-sync.js";

const EXECUTION_UNKNOWN: PortfolioExecutionTruth = {
  status: "unknown",
  evidence: [],
  reason: "assignment_is_not_execution_evidence",
};

function truth(value: unknown): PortfolioInventoryTruth {
  return value === null || value === undefined ? "unknown" : "known";
}

function unknownFields(values: Record<string, PortfolioInventoryTruth>): string[] {
  return Object.entries(values)
    .filter(([, value]) => value === "unknown")
    .map(([field]) => field)
    .sort();
}

export function normalizePortfolioProject(project: PortfolioInventoryProject): NormalizedPortfolioProject {
  const fieldTruth = {
    url: truth(project.url),
    state: truth(project.state),
    assignee: truth(project.lead),
    creator: truth(project.creator),
    project: "known" as const,
    createdAt: truth(project.createdAt),
    updatedAt: truth(project.updatedAt),
    execution: "unknown" as const,
  };
  return {
    kind: "project",
    sourceKind: "linear",
    sourceId: project.id,
    identifier: null,
    title: project.name,
    name: project.name,
    url: project.url,
    state: project.state,
    project: { id: project.id, name: project.name, url: project.url, state: project.state },
    assignee: project.lead ? { kind: "lead", identity: project.lead } : null,
    creator: project.creator,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    execution: { ...EXECUTION_UNKNOWN, evidence: [] },
    truth: fieldTruth,
    unknownFields: unknownFields(fieldTruth),
  };
}

export function normalizePortfolioIssue(issue: PortfolioInventoryIssue): NormalizedPortfolioIssue {
  const fieldTruth = {
    url: truth(issue.url),
    state: truth(issue.state?.name),
    assignee: truth(issue.assignee),
    creator: truth(issue.creator),
    project: truth(issue.project),
    createdAt: truth(issue.createdAt),
    updatedAt: truth(issue.updatedAt),
    execution: "unknown" as const,
  };
  return {
    kind: "issue",
    sourceKind: "linear",
    sourceId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    name: issue.title,
    url: issue.url,
    state: issue.state?.name ?? null,
    project: issue.project,
    assignee: issue.assignee,
    creator: issue.creator,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    execution: { ...EXECUTION_UNKNOWN, evidence: [] },
    truth: fieldTruth,
    unknownFields: unknownFields(fieldTruth),
  };
}

function countStates(records: NormalizedPortfolioRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const state = record.state ?? "unknown";
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function combinePortfolioInventory(
  projects: PortfolioInventoryProject[],
  issues: PortfolioInventoryIssue[],
  meta: PortfolioInventorySourceMeta,
): PortfolioInventorySnapshot {
  const normalizedProjects = projects.map(normalizePortfolioProject).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const normalizedIssues = issues.map(normalizePortfolioIssue).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const records: NormalizedPortfolioRecord[] = [...normalizedIssues, ...normalizedProjects].sort((a, b) =>
    a.kind === b.kind ? a.sourceId.localeCompare(b.sourceId) : a.kind.localeCompare(b.kind),
  );
  const unavailableReason = "The Linear Sync plugin does not collect this source in Phase 1 and did not broaden its capabilities.";
  const recordUnknowns = records
    .filter((record) => record.unknownFields.length > 0)
    .map((record) => ({
      kind: record.kind,
      sourceId: record.sourceId,
      fields: [...record.unknownFields],
      reason: "Source did not provide these fields; no value was inferred.",
    }));
  const sourceUnknowns: PortfolioInventorySnapshot["unknowns"] = ["github", "paperclip", "sessionPresence"].map((sourceId) => ({
    kind: "source",
    sourceId,
    fields: ["availability"],
    reason: unavailableReason,
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "read_only",
    source: meta.source,
    sources: {
      linear: meta.source,
      paperclip: { availability: "unavailable", truth: "unknown", reason: unavailableReason },
      github: { availability: "unavailable", truth: "unknown", reason: unavailableReason },
      sessionPresence: { availability: "unavailable", truth: "unknown", reason: unavailableReason },
    },
    pagination: { pageSize: meta.pageSize, maxPages: meta.maxPages, maxRecords: meta.maxRecords },
    denominators: { projects: normalizedProjects.length, issues: normalizedIssues.length, records: records.length },
    stateCounts: { projects: countStates(normalizedProjects), issues: countStates(normalizedIssues) },
    records,
    unknowns: [...recordUnknowns, ...sourceUnknowns].sort((a, b) =>
      a.kind === b.kind ? a.sourceId.localeCompare(b.sourceId) : a.kind.localeCompare(b.kind),
    ),
    externalMutations: 0,
    truncated: false,
  };
}

export async function collectPortfolioInventory(
  linear: LinearClient,
  meta: PortfolioInventorySourceMeta,
): Promise<PortfolioInventorySnapshot> {
  const [projects, issues] = await Promise.all([
    linear.listAllProjects({ pageSize: meta.pageSize, maxPages: meta.maxPages, maxRecords: meta.maxRecords }),
    linear.listAllIssues({ pageSize: meta.pageSize, maxPages: meta.maxPages, maxRecords: meta.maxRecords }),
  ]);
  return combinePortfolioInventory(projects.records, issues.records, meta);
}
