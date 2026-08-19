import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import type { LinearClient, LinearIssue } from "./linear-sync.js";
import type {
  LinearPageInfo,
  LinearPaginationResult,
  PortfolioInventoryIssue,
  PortfolioInventoryProject,
} from "./portfolio-types.js";

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type GraphqlPage<T> = {
  nodes: T[];
  pageInfo: LinearPageInfo;
};

const DEFAULT_PAGE_SIZE = 100;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_RECORDS = 5000;

function clampPageSize(value?: number): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_PAGE_SIZE;
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, Math.trunc(value ?? DEFAULT_PAGE_SIZE)));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(1, Math.trunc(value ?? fallback));
}

async function graphql<T>(
  http: PluginHttpClient,
  url: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await http.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: token.replace(/^Bearer\s+/i, ""),
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  let parsed: GraphqlResponse<T>;
  try {
    parsed = JSON.parse(text) as GraphqlResponse<T>;
  } catch {
    throw new Error(`Linear GraphQL returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok || parsed.errors?.length) {
    const message = parsed.errors?.map((error) => error.message ?? "Unknown Linear error").join("; ") || text.slice(0, 300);
    throw new Error(`Linear GraphQL failed (${response.status}): ${message}`);
  }
  if (!parsed.data) throw new Error("Linear GraphQL response did not include data");
  return parsed.data;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  createdAt
  updatedAt
  state { id name }
  team { id key name }
`;

const INVENTORY_ISSUE_FIELDS = `
  id
  identifier
  title
  url
  createdAt
  updatedAt
  state { id name }
  assignee { id name }
  creator { id name }
  project { id name url state }
`;

const PROJECT_FIELDS = `
  id
  name
  url
  createdAt
  updatedAt
  state
  lead { id name }
  creator { id name }
`;

function validatePageInfo(collectionName: string, pageInfo: unknown): asserts pageInfo is LinearPageInfo {
  if (!pageInfo || typeof pageInfo !== "object") {
    throw new Error(`Linear GraphQL response for ${collectionName} was missing pagination fields`);
  }
  const info = pageInfo as Record<string, unknown>;
  if (typeof info.hasNextPage !== "boolean") {
    throw new Error(`Linear GraphQL response for ${collectionName} had invalid hasNextPage`);
  }
  if (!(typeof info.endCursor === "string" || info.endCursor === null)) {
    throw new Error(`Linear GraphQL response for ${collectionName} had invalid endCursor`);
  }
  if (typeof info.endCursor === "string" && info.endCursor.trim().length === 0) {
    throw new Error(`Linear GraphQL response for ${collectionName} had an empty endCursor`);
  }
}

async function paginate<T extends { id: string }>(input: {
  collectionName: string;
  http: PluginHttpClient;
  url: string;
  token: string;
  query: string;
  variables: Record<string, unknown>;
  pageSize?: number;
  maxPages?: number;
  maxRecords?: number;
}): Promise<LinearPaginationResult<T>> {
  const pageSize = clampPageSize(input.pageSize);
  const maxPages = positiveInteger(input.maxPages, MAX_PAGES);
  const maxRecords = positiveInteger(input.maxRecords, MAX_RECORDS);
  const records: T[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;

  while (true) {
    if (pageCount >= maxPages) {
      throw new Error(`Linear GraphQL pagination for ${input.collectionName} exceeded maxPages=${maxPages}`);
    }
    pageCount += 1;
    const pageDataResponse: Record<string, GraphqlPage<T>> = await graphql<Record<string, GraphqlPage<T>>>(
      input.http,
      input.url,
      input.token,
      input.query,
      { ...input.variables, first: pageSize, after: cursor },
    );
    const pageData: GraphqlPage<T> | undefined = pageDataResponse[input.collectionName];
    if (!pageData || !Array.isArray(pageData.nodes)) {
      throw new Error(`Linear GraphQL response for ${input.collectionName} was missing nodes`);
    }
    validatePageInfo(input.collectionName, pageData.pageInfo);

    const pageIds = new Set<string>();
    for (const record of pageData.nodes) {
      if (!record || typeof record.id !== "string" || record.id.trim().length === 0) {
        throw new Error(`Linear GraphQL response for ${input.collectionName} contained a record without a source id`);
      }
      if (pageIds.has(record.id)) {
        throw new Error(`Linear GraphQL response for ${input.collectionName} contained duplicate source id ${record.id} on one page`);
      }
      pageIds.add(record.id);
      if (seenIds.has(record.id)) {
        throw new Error(`Linear GraphQL response for ${input.collectionName} contained duplicate source id ${record.id}`);
      }
      if (records.length + 1 > maxRecords) {
        throw new Error(`Linear GraphQL pagination for ${input.collectionName} exceeded maxRecords=${maxRecords}`);
      }
      seenIds.add(record.id);
      records.push(record);
    }

    if (!pageData.pageInfo.hasNextPage) break;
    if (records.length >= maxRecords) {
      throw new Error(`Linear GraphQL pagination for ${input.collectionName} exceeded maxRecords=${maxRecords}`);
    }
    if (!pageData.pageInfo.endCursor) {
      throw new Error(`Linear GraphQL response for ${input.collectionName} was missing an end cursor while reporting more pages`);
    }
    if (seenCursors.has(pageData.pageInfo.endCursor)) {
      throw new Error(`Linear GraphQL pagination for ${input.collectionName} repeated cursor ${pageData.pageInfo.endCursor}`);
    }
    seenCursors.add(pageData.pageInfo.endCursor);
    cursor = pageData.pageInfo.endCursor;
  }

  return { records, pageCount, pageSize, truncated: false };
}

export function createLinearClient(input: { http: PluginHttpClient; url: string; token: string }): LinearClient {
  return {
    async listCandidateIssues({ stateNames, first, updatedAfter }) {
      const data = await graphql<{
        issues: { nodes: LinearIssue[] };
      }>(
        input.http,
        input.url,
        input.token,
        `query PaperclipCandidateIssues($stateNames: [String!], $first: Int!, $updatedAfter: DateTimeOrDuration) {
          issues(
            first: $first,
            orderBy: updatedAt,
            filter: {
              state: { name: { in: $stateNames } }
              updatedAt: { gt: $updatedAfter }
            }
          ) {
            nodes { ${ISSUE_FIELDS} }
          }
        }`,
        { stateNames, first, updatedAfter },
      );
      return data.issues.nodes;
    },

    async getIssue(issueId) {
      const data = await graphql<{ issue: LinearIssue | null }>(
        input.http,
        input.url,
        input.token,
        `query PaperclipIssue($id: String!) {
          issue(id: $id) { ${ISSUE_FIELDS} }
        }`,
        { id: issueId },
      );
      return data.issue;
    },

    async listAllProjects(params) {
      return paginate<PortfolioInventoryProject>({
        collectionName: "projects",
        http: input.http,
        url: input.url,
        token: input.token,
        query: `query PaperclipProjects($first: Int!, $after: String) {
          projects(first: $first, after: $after, orderBy: updatedAt, includeArchived: true) {
            nodes { ${PROJECT_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: {},
        pageSize: params?.pageSize,
        maxPages: params?.maxPages,
        maxRecords: params?.maxRecords,
      });
    },

    async listAllIssues(params) {
      return paginate<PortfolioInventoryIssue>({
        collectionName: "issues",
        http: input.http,
        url: input.url,
        token: input.token,
        query: `query PaperclipIssues($first: Int!, $after: String) {
          issues(first: $first, after: $after, orderBy: updatedAt, includeArchived: true) {
            nodes { ${INVENTORY_ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: {},
        pageSize: params?.pageSize,
        maxPages: params?.maxPages,
        maxRecords: params?.maxRecords,
      });
    },

    async postImportComment(issueId, body) {
      await graphql(
        input.http,
        input.url,
        input.token,
        `mutation PaperclipComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }`,
        { issueId, body },
      );
    },

    async moveIssueToState(issueId, stateId) {
      await graphql(
        input.http,
        input.url,
        input.token,
        `mutation PaperclipMoveIssue($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success }
        }`,
        { id: issueId, stateId },
      );
    },
  };
}
