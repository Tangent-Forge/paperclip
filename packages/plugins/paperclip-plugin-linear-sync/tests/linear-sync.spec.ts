import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { API_ROUTE_KEYS, ORIGIN_KIND_LINEAR_ISSUE } from "../src/constants.js";
import { createLinearClient } from "../src/linear-client.js";
import { handleWebhookIssue, importLinearIssue, isCandidateLinearIssue, readConfig, runLinearSync, verifyLinearSignature, type LinearClient, type LinearIssue, type SyncHost } from "../src/linear-sync.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
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
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  labelIds: string[];
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
    project: null,
    labels: { nodes: [] },
    parent: null,
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
        if (sql.includes("FROM") && sql.includes("linear_issue_links") && sql.includes("linear_issue_id = $2")) {
          const [companyId, linearIssueId] = params as string[];
          const row = links.get(`${companyId}:${linearIssueId}`);
          return (row ? [row] : []) as any;
        }
        if (sql.includes("FROM") && sql.includes("sync_runs")) return runs as any;
        if (sql.includes("GROUP BY status")) return [{ status: "linked", count: String([...links.values()].filter((row) => row.status === "linked").length) }] as any;
        return [] as any;
      },
      async execute(sql: string, params: unknown[] = []) {
        if (sql.includes("INSERT INTO") && sql.includes("linear_issue_links")) {
          const [id, companyId, linearIssueId, linearIdentifier, lastUpdated, metadata] = params as string[];
          const key = `${companyId}:${linearIssueId}`;
          const existingRow = links.get(key);
          const row = existingRow ?? {
            id,
            company_id: companyId,
            linear_issue_id: linearIssueId,
            paperclip_issue_id: null,
            last_linear_updated_at: lastUpdated,
            status: "reserved",
          };
          row.linear_identifier = linearIdentifier;
          row.metadata = metadata ? { ...(row.metadata ?? {}), ...JSON.parse(metadata) } : (row.metadata ?? {});
          links.set(key, row);
          return { rowCount: 1 };
        }
        if (sql.includes("UPDATE") && sql.includes("linear_issue_links")) {
          if (sql.includes("paperclip_issue_id")) {
            const [paperclipIssueId, identifier, updatedAt, metadata, linkId, companyId] = params as string[];
            const row = [...links.values()].find((candidate) => candidate.id === linkId && candidate.company_id === companyId);
            if (row) {
              row.paperclip_issue_id = paperclipIssueId;
              row.linear_identifier = identifier;
              row.last_linear_updated_at = updatedAt;
              row.status = "linked";
              row.metadata = metadata ? { ...(row.metadata ?? {}), ...JSON.parse(metadata) } : (row.metadata ?? {});
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
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          parentId: input.parentId ?? null,
          labelIds: input.labelIds ?? [],
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
  it("declares updatedAfter as DateTimeOrDuration for Linear updatedAt filters", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain("$updatedAfter: DateTimeOrDuration");
      expect(body.query).not.toContain("$updatedAfter: DateTime)");
      expect(body.query).toContain("initiatives { nodes { id name url } }");
      expect(body.query).toContain("labels { nodes { id name color } }");
      expect(body.query).toContain("parent { id identifier title url }");
      expect(body.variables.updatedAfter).toBe("2026-06-01T00:00:00.000Z");
      return new Response(JSON.stringify({ data: { issues: { nodes: [linearIssue()] } } }), { status: 200 });
    });
    const client = createLinearClient({ http: { fetch } as any, url: "https://api.linear.test/graphql", token: "lin-token" });

    const issues = await client.listCandidateIssues({ stateNames: ["Todo"], first: 1, updatedAfter: "2026-06-01T00:00:00.000Z" });

    expect(issues).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes config defaults", () => {
    expect(readConfig({}).candidateStatusNames).toEqual(["Backlog", "Todo"]);
    expect(readConfig({ maxIssuesPerRun: 1000 }).maxIssuesPerRun).toBe(100);
    expect(readConfig({ linearProjectIdToPaperclipProjectId: { " linear-project ": " paperclip-project " } }).linearProjectIdToPaperclipProjectId).toEqual({ "linear-project": "paperclip-project" });
  });

  it("matches candidate statuses case-insensitively", () => {
    const config = readConfig({ candidateStatusNames: ["backlog"] });
    expect(isCandidateLinearIssue(linearIssue({ state: { name: "Backlog" } }), config)).toBe(true);
    expect(isCandidateLinearIssue(linearIssue({ state: { name: "Done" } }), config)).toBe(false);
  });

  it("imports a Linear issue once and dedupes by origin id on repeated runs", async () => {
    const { host, issues } = fakeHost();
    const linear = fakeLinear([linearIssue({
      project: { id: "linear-project-1", name: "Project", url: null, initiatives: { nodes: [{ id: "linear-initiative-1", name: "Initiative", url: null }] } },
      labels: { nodes: [{ id: "linear-label-1", name: "Label", color: null }] },
    })]);
    const config = readConfig({
      enabled: true,
      linearApiKeySecretRef: "LINEAR",
      triageAgentId: "agent-1",
      linearProjectIdToPaperclipProjectId: { "linear-project-1": "paperclip-project-1" },
      linearInitiativeIdToPaperclipGoalId: { "linear-initiative-1": "paperclip-goal-1" },
      linearLabelIdToPaperclipLabelId: { "linear-label-1": "paperclip-label-1" },
    });

    await runLinearSync({ host, linear, companyId: "company-1", config, triggerKind: "manual" });
    await runLinearSync({ host, linear, companyId: "company-1", config, triggerKind: "manual" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      originKind: ORIGIN_KIND_LINEAR_ISSUE,
      originId: "lin-1",
      status: "todo",
      projectId: "paperclip-project-1",
      goalId: "paperclip-goal-1",
      labelIds: ["paperclip-label-1"],
    });
    expect(host.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(linear.postImportComment).toHaveBeenCalledTimes(1);
  });

  it("maps source structure on create and preserves the exact source metadata", async () => {
    const { host, issues, links } = fakeHost();
    const config = readConfig({
      enabled: true,
      linearApiKeySecretRef: "LINEAR",
      postImportComment: false,
      linearProjectIdToPaperclipProjectId: { "linear-project-1": "paperclip-project-1" },
      linearInitiativeIdToPaperclipGoalId: {
        "linear-initiative-a": "paperclip-goal-a",
        "linear-initiative-z": "paperclip-goal-z",
      },
      linearLabelIdToPaperclipLabelId: { "linear-label-1": "paperclip-label-1" },
    });
    const parent = linearIssue({ id: "lin-parent", identifier: "TAN-2", title: "Parent" });
    const child = linearIssue({
      id: "lin-child",
      identifier: "TAN-3",
      title: "Child",
      priority: 1,
      project: {
        id: "linear-project-1",
        name: "Linear project",
        url: "https://linear.test/project-1",
        initiatives: { nodes: [
          { id: "linear-initiative-z", name: "Later initiative", url: "https://linear.test/initiative-z" },
          { id: "linear-initiative-a", name: "Linear initiative", url: "https://linear.test/initiative-a" },
        ] },
      },
      labels: { nodes: [
        { id: "linear-label-1", name: "Mapped", color: "#111111" },
        { id: "linear-label-unmapped", name: "Unmapped", color: "#222222" },
      ] },
      parent: { id: "lin-parent", identifier: "TAN-2", title: "Parent", url: "https://linear.test/TAN-2" },
    });

    await importLinearIssue({ host, linear: fakeLinear([parent, child]), companyId: "company-1", config, issue: parent });
    const result = await importLinearIssue({ host, linear: fakeLinear([parent, child]), companyId: "company-1", config, issue: child });

    expect(result).toBe("imported");
    expect(issues[1]).toMatchObject({
      projectId: "paperclip-project-1",
      goalId: "paperclip-goal-a",
      parentId: issues[0]?.id,
      labelIds: ["paperclip-label-1"],
      priority: "critical",
    });
    expect(links.get("company-1:lin-child")?.metadata).toMatchObject({
      linear: {
        priority: 1,
        project: { id: "linear-project-1", name: "Linear project" },
        initiatives: [
          { id: "linear-initiative-z", name: "Later initiative" },
          { id: "linear-initiative-a", name: "Linear initiative" },
        ],
        labels: [
          { id: "linear-label-1", paperclipLabelId: "paperclip-label-1" },
          { id: "linear-label-unmapped", paperclipLabelId: null },
        ],
        parent: { id: "lin-parent", identifier: "TAN-2" },
      },
      unmapped: { labelIds: ["linear-label-unmapped"] },
    });
  });

  it("updates native structure without creating a second Paperclip issue", async () => {
    const { host, issues, links } = fakeHost();
    const config = readConfig({
      enabled: true,
      linearApiKeySecretRef: "LINEAR",
      postImportComment: false,
      linearProjectIdToPaperclipProjectId: {
        "linear-project-1": "paperclip-project-1",
        "linear-project-2": "paperclip-project-2",
      },
      linearInitiativeIdToPaperclipGoalId: {
        "linear-initiative-1": "paperclip-goal-1",
        "linear-initiative-2": "paperclip-goal-2",
      },
      linearLabelIdToPaperclipLabelId: {
        "linear-label-1": "paperclip-label-1",
        "linear-label-2": "paperclip-label-2",
      },
    });
    const original = linearIssue({
      project: { id: "linear-project-1", name: "Project 1", url: null, initiatives: { nodes: [{ id: "linear-initiative-1", name: "Initiative 1", url: null }] } },
      labels: { nodes: [{ id: "linear-label-1", name: "Label 1", color: null }] },
    });
    await importLinearIssue({ host, linear: fakeLinear([original]), companyId: "company-1", config, issue: original });
    const updated = linearIssue({
      title: "Updated structure",
      updatedAt: "2026-05-03T00:00:00.000Z",
      priority: 4,
      project: { id: "linear-project-2", name: "Project 2", url: null, initiatives: { nodes: [{ id: "linear-initiative-2", name: "Initiative 2", url: null }] } },
      labels: { nodes: [{ id: "linear-label-2", name: "Label 2", color: null }] },
    });

    const result = await importLinearIssue({ host, linear: fakeLinear([updated]), companyId: "company-1", config, issue: updated });

    expect(result).toBe("updated");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      title: "[TAN-1] Updated structure",
      projectId: "paperclip-project-2",
      goalId: "paperclip-goal-2",
      labelIds: ["paperclip-label-2"],
      priority: "low",
    });
    expect(links.get("company-1:lin-1")?.metadata).toMatchObject({
      linear: { project: { id: "linear-project-2" }, initiatives: [{ id: "linear-initiative-2" }], labels: [{ id: "linear-label-2" }] },
      paperclip: { projectId: "paperclip-project-2", goalId: "paperclip-goal-2", labelIds: ["paperclip-label-2"], priority: "low" },
    });
  });

  it("preserves structured imports through poll and webhook paths", async () => {
    const { host, issues } = fakeHost();
    const config = readConfig({
      enabled: true,
      linearApiKeySecretRef: "LINEAR",
      postImportComment: false,
      linearLabelIdToPaperclipLabelId: { "linear-label-1": "paperclip-label-1" },
    });
    const polled = linearIssue({ labels: { nodes: [{ id: "linear-label-1", name: "Label", color: null }] } });
    const webhook = linearIssue({ id: "lin-webhook", identifier: "TAN-4", labels: { nodes: [{ id: "linear-label-1", name: "Label", color: null }] } });
    const linear = fakeLinear([polled, webhook]);

    const pollSummary = await runLinearSync({ host, linear, companyId: "company-1", config, triggerKind: "poll" });
    const webhookSummary = await handleWebhookIssue({ host, linear, companyId: "company-1", config, payload: { data: { id: "lin-webhook" } } });

    expect(pollSummary).toMatchObject({ status: "success", importedCount: 2 });
    expect(webhookSummary).toMatchObject({ status: "success", skippedDuplicateCount: 1 });
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.labelIds)).toEqual([["paperclip-label-1"], ["paperclip-label-1"]]);
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

  it("lets manual sync bypass an active failure cooldown", async () => {
    const { host, issues, state } = fakeHost();
    state.set("company-1:sync-state", {
      cooldownUntil: "2099-01-01T00:00:00.000Z",
      consecutiveFailures: 7,
      lastSuccessAt: "2026-06-10T15:30:04.547Z",
    });
    const linear = fakeLinear([linearIssue()]);
    const config = readConfig({ enabled: true, linearApiKeySecretRef: "LINEAR", postImportComment: false });

    const summary = await runLinearSync({ host, linear, companyId: "company-1", config, triggerKind: "manual" });

    expect(summary.status).toBe("success");
    expect(issues).toHaveLength(1);
    expect(linear.listCandidateIssues).toHaveBeenCalledTimes(1);
    expect(state.get("company-1:sync-state")).toMatchObject({ consecutiveFailures: 0, cooldownUntil: null });
  });

  it("verifies Linear HMAC signatures", () => {
    const body = JSON.stringify({ action: "create" });
    const signature = createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyLinearSignature({ rawBody: body, headers: { "linear-signature": signature }, secret: "secret" })).toBe(true);
    expect(verifyLinearSignature({ rawBody: body, headers: { "linear-signature": signature }, secret: "wrong" })).toBe(false);
  });
});
