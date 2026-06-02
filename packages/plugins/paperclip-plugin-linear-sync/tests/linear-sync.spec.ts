import { describe, expect, it, vi } from "vitest";
import { ORIGIN_KIND_LINEAR_ISSUE } from "../src/constants.js";
import { importLinearIssue, isCandidateLinearIssue, readConfig, runLinearSync, verifyLinearSignature, type LinearClient, type LinearIssue, type SyncHost } from "../src/linear-sync.js";
import { createHmac } from "node:crypto";

type IssueRecord = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
  originKind: string | null;
  originId: string | null;
};

function linearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "lin-1",
    identifier: "TAN-1",
    title: "Import me",
    description: "Linear body",
    url: "https://linear.test/TAN-1",
    priority: 2,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    state: { id: "state-todo", name: "Todo" },
    team: { id: "team-1", key: "TAN", name: "Tangent" },
    ...overrides,
  };
}

function fakeHost() {
  const issues: IssueRecord[] = [];
  const links = new Map<string, any>();
  const state = new Map<string, unknown>();
  const runs: any[] = [];
  const host: SyncHost = {
    db: {
      namespace: "plugin_linear_sync_861efcc900",
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("INSERT INTO") && sql.includes("linear_issue_links")) {
          const [id, companyId, linearIssueId, linearIdentifier, lastUpdated, metadata] = params as string[];
          const key = `${companyId}:${linearIssueId}`;
          const row = links.get(key) ?? {
            id,
            company_id: companyId,
            linear_issue_id: linearIssueId,
            paperclip_issue_id: null,
            status: "reserved",
          };
          row.linear_identifier = linearIdentifier;
          row.last_linear_updated_at = lastUpdated;
          row.metadata = metadata ? JSON.parse(metadata) : {};
          links.set(key, row);
          return [row] as any;
        }
        if (sql.includes("FROM") && sql.includes("sync_runs")) return runs as any;
        if (sql.includes("GROUP BY status")) return [{ status: "linked", count: String([...links.values()].filter((row) => row.status === "linked").length) }] as any;
        return [] as any;
      },
      async execute(sql: string, params: unknown[] = []) {
        if (sql.includes("UPDATE") && sql.includes("linear_issue_links")) {
          if (sql.includes("paperclip_issue_id")) {
            const [paperclipIssueId, identifier, updatedAt, linkId, companyId] = params as string[];
            const row = [...links.values()].find((candidate) => candidate.id === linkId && candidate.company_id === companyId);
            if (row) {
              row.paperclip_issue_id = paperclipIssueId;
              row.linear_identifier = identifier;
              row.last_linear_updated_at = updatedAt;
              row.status = "linked";
            }
          }
          return { rowCount: 1 };
        }
        if (sql.includes("INSERT INTO") && sql.includes("sync_runs")) {
          runs.push({ params });
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
    issues: {
      async list(input) {
        return issues.filter((issue) => (!input.originKind || issue.originKind === input.originKind) && (!input.originId || issue.originId === input.originId)).slice(0, input.limit ?? issues.length) as any;
      },
      async create(input) {
        const issue: IssueRecord = {
          id: `pc-${issues.length + 1}`,
          identifier: `PC-${issues.length + 1}`,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? "todo",
          priority: input.priority ?? "medium",
          originKind: input.originKind ?? null,
          originId: input.originId ?? null,
        };
        issues.push(issue);
        return issue as any;
      },
      async update(issueId, patch) {
        const issue = issues.find((candidate) => candidate.id === issueId);
        if (!issue) throw new Error("missing issue");
        Object.assign(issue, patch);
        return issue as any;
      },
      requestWakeup: vi.fn(async () => ({ queued: true })),
    },
    state: {
      async get(input) { return state.get(`${input.scopeId}:${input.stateKey}`) ?? null; },
      async set(input, value) { state.set(`${input.scopeId}:${input.stateKey}`, value); },
    },
    activity: { log: vi.fn(async () => undefined) },
    metrics: { write: vi.fn(async () => undefined) },
    telemetry: { track: vi.fn(async () => undefined) },
  };
  return { host, issues, links, state, runs };
}

function fakeLinear(issues: LinearIssue[]): LinearClient {
  return {
    listCandidateIssues: vi.fn(async () => issues),
    getIssue: vi.fn(async (id) => issues.find((issue) => issue.id === id) ?? null),
    postImportComment: vi.fn(async () => undefined),
    moveIssueToState: vi.fn(async () => undefined),
  };
}

describe("linear sync", () => {
  it("normalizes config defaults", () => {
    expect(readConfig({}).candidateStatusNames).toEqual(["Backlog", "Todo"]);
    expect(readConfig({ maxIssuesPerRun: 1000 }).maxIssuesPerRun).toBe(100);
  });

  it("matches candidate statuses case-insensitively", () => {
    const config = readConfig({ candidateStatusNames: ["backlog"] });
    expect(isCandidateLinearIssue(linearIssue({ state: { name: "Backlog" } }), config)).toBe(true);
    expect(isCandidateLinearIssue(linearIssue({ state: { name: "Done" } }), config)).toBe(false);
  });

  it("imports a Linear issue once and dedupes by origin id on repeated runs", async () => {
    const { host, issues } = fakeHost();
    const linear = fakeLinear([linearIssue()]);
    const config = readConfig({ enabled: true, linearApiKeySecretRef: "LINEAR", triageAgentId: "agent-1" });

    await runLinearSync({ host, linear, companyId: "company-1", config, triggerKind: "manual" });
    await runLinearSync({ host, linear, companyId: "company-1", config, triggerKind: "manual" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ originKind: ORIGIN_KIND_LINEAR_ISSUE, originId: "lin-1", status: "todo" });
    expect(host.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(linear.postImportComment).toHaveBeenCalledTimes(1);
  });

  it("updates an existing imported issue when Linear updatedAt advances", async () => {
    const { host, issues } = fakeHost();
    const linear = fakeLinear([linearIssue()]);
    const config = readConfig({ enabled: true, linearApiKeySecretRef: "LINEAR", postImportComment: false });

    await importLinearIssue({ host, linear, companyId: "company-1", config, issue: linearIssue() });
    const result = await importLinearIssue({ host, linear, companyId: "company-1", config, issue: linearIssue({ title: "Updated", updatedAt: "2026-05-03T00:00:00.000Z" }) });

    expect(result).toBe("updated");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toContain("Updated");
  });

  it("skips disabled sync without failing or importing", async () => {
    const { host, issues } = fakeHost();
    const summary = await runLinearSync({ host, linear: fakeLinear([linearIssue()]), companyId: "company-1", config: readConfig({ enabled: false }), triggerKind: "poll" });
    expect(summary).toMatchObject({ status: "skipped", disabled: true });
    expect(issues).toHaveLength(0);
  });

  it("verifies Linear HMAC signatures", () => {
    const body = JSON.stringify({ action: "create" });
    const signature = createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyLinearSignature({ rawBody: body, headers: { "linear-signature": signature }, secret: "secret" })).toBe(true);
    expect(verifyLinearSignature({ rawBody: body, headers: { "linear-signature": signature }, secret: "wrong" })).toBe(false);
  });
});
