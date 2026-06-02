import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import type { LinearClient, LinearIssue } from "./linear-sync.js";

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

async function graphql<T>(http: PluginHttpClient, url: string, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
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

export function createLinearClient(input: { http: PluginHttpClient; url: string; token: string }): LinearClient {
  return {
    async listCandidateIssues({ stateNames, first, updatedAfter }) {
      const data = await graphql<{
        issues: { nodes: LinearIssue[] };
      }>(
        input.http,
        input.url,
        input.token,
        `query PaperclipCandidateIssues($stateNames: [String!], $first: Int!, $updatedAfter: DateTime) {
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
