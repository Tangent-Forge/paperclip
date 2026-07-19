export type PortfolioInventoryTruth = "known" | "unknown";

export type PortfolioIdentity = {
  id: string | null;
  name: string | null;
};

export type PortfolioInventorySource = {
  kind: "linear";
  label: "Linear";
  host: "api.linear.app";
  availability: "available";
};

export type PortfolioInventorySourceMeta = {
  source: PortfolioInventorySource;
  pageSize: number;
  maxPages: number;
  maxRecords: number;
};

export type LinearPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

export type LinearPaginationResult<T> = {
  records: T[];
  pageCount: number;
  pageSize: number;
  truncated: false;
};

export type PortfolioInventoryProject = {
  id: string;
  name: string;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  state: string | null;
  lead: PortfolioIdentity | null;
  creator: PortfolioIdentity | null;
};

export type PortfolioInventoryIssue = {
  id: string;
  identifier: string | null;
  title: string;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  state: { id: string | null; name: string | null } | null;
  assignee: PortfolioIdentity | null;
  creator: PortfolioIdentity | null;
  project: {
    id: string | null;
    name: string | null;
    url: string | null;
    state: string | null;
  } | null;
};

export type PortfolioExecutionTruth = {
  status: "unknown";
  evidence: [];
  reason: "assignment_is_not_execution_evidence";
};

export type NormalizedPortfolioProject = {
  kind: "project";
  sourceKind: "linear";
  sourceId: string;
  identifier: null;
  title: string;
  name: string;
  url: string | null;
  state: string | null;
  project: { id: string; name: string; url: string | null; state: string | null };
  assignee: { kind: "lead"; identity: PortfolioIdentity } | null;
  creator: PortfolioIdentity | null;
  createdAt: string | null;
  updatedAt: string | null;
  execution: PortfolioExecutionTruth;
  truth: {
    url: PortfolioInventoryTruth;
    state: PortfolioInventoryTruth;
    assignee: PortfolioInventoryTruth;
    creator: PortfolioInventoryTruth;
    project: "known";
    createdAt: PortfolioInventoryTruth;
    updatedAt: PortfolioInventoryTruth;
    execution: "unknown";
  };
  unknownFields: string[];
};

export type NormalizedPortfolioIssue = {
  kind: "issue";
  sourceKind: "linear";
  sourceId: string;
  identifier: string | null;
  title: string;
  name: string;
  url: string | null;
  state: string | null;
  project: PortfolioInventoryIssue["project"];
  assignee: PortfolioIdentity | null;
  creator: PortfolioIdentity | null;
  createdAt: string | null;
  updatedAt: string | null;
  execution: PortfolioExecutionTruth;
  truth: {
    url: PortfolioInventoryTruth;
    state: PortfolioInventoryTruth;
    assignee: PortfolioInventoryTruth;
    creator: PortfolioInventoryTruth;
    project: PortfolioInventoryTruth;
    createdAt: PortfolioInventoryTruth;
    updatedAt: PortfolioInventoryTruth;
    execution: "unknown";
  };
  unknownFields: string[];
};

export type NormalizedPortfolioRecord = NormalizedPortfolioProject | NormalizedPortfolioIssue;

export type PortfolioUnavailableSource = {
  availability: "unavailable";
  truth: "unknown";
  reason: string;
};

export type PortfolioInventorySnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  mode: "read_only";
  source: PortfolioInventorySource;
  sources: {
    linear: PortfolioInventorySource;
    paperclip: PortfolioUnavailableSource;
    github: PortfolioUnavailableSource;
    sessionPresence: PortfolioUnavailableSource;
  };
  pagination: { pageSize: number; maxPages: number; maxRecords: number };
  denominators: { projects: number; issues: number; records: number };
  stateCounts: {
    projects: Record<string, number>;
    issues: Record<string, number>;
  };
  records: NormalizedPortfolioRecord[];
  unknowns: Array<{
    kind: NormalizedPortfolioRecord["kind"] | "source";
    sourceId: string;
    fields: string[];
    reason: string;
  }>;
  externalMutations: 0;
  truncated: false;
};
