import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { API_ROUTE_KEYS, ORIGIN_KIND_LINEAR_ISSUE } from "../src/constants.js";
import { createLinearClient } from "../src/linear-client.js";
import { collectPortfolioInventory, combinePortfolioInventory, normalizePortfolioIssue, normalizePortfolioProject } from "../src/portfolio-inventory.js";
import {
  importLinearIssue,
  isCandidateLinearIssue,
  readConfig,
  runLinearSync,
  verifyLinearSignature,
  type LinearClient,
  type LinearIssue,
  type SyncHost,
} from "../src/linear-sync.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  evaluateCompletion,
  parseWorkContract,
  reconcileWorkState,
  stableLinearWorkId,
  type WorkContract,
} from "../src/work-contract.js";
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

function workContract(linearIssueId = "lin-1", overrides: Partial<WorkContract> = {}): WorkContract {
  return {
    version: "tf-work/v1",
    workId: stableLinearWorkId(linearIssueId),
    outcome: "Produce an independently reviewable delivery.",
    classification: "standard",
    roles: { accountableOwner: "TF Chief of Staff", executionQueue: "paperclip", evaluator: "work-evaluator" },
    scope: { included: ["requested outcome"], excluded: ["outreach", "deployment"] },
    executionEnvelope: { allowedActions: ["local implementation", "tests"], prohibitedActions: ["deploy", "send outreach"] },
    requirements: ["preserve evidence"],
    acceptance: { criteria: ["targeted tests pass"], requiredReceipts: ["test"], deliveryState: "local_commit_reviewable" },
    dependencies: [],
    stopConditions: ["approval boundary reached"],
    rollback: "Revert the isolated commit.",
    ...overrides,
  };
}

function contractDescription(linearIssueId = "lin-1"): string {
  return `Linear body\n\n\`\`\`tf-work-contract\n${JSON.stringify(workContract(linearIssueId), null, 2)}\n\`\`\``;
}

function linearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "lin-1",
    identifier: "TAN-1",
    title: "Import me",
    description: contractDescription(),
    url: "https://linear.test/TAN-1",
    priority: 2,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    state: { id: "state-triage", name: "Triage" },
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
    listAllProjects: vi.fn(async () => ({ records: [], pageCount: 1, pageSize: 100, truncated: false as const })),
    listAllIssues: vi.fn(async () => ({ records: [], pageCount: 1, pageSize: 100, truncated: false as const })),
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
      expect(body.variables.updatedAfter).toBe("2026-06-01T00:00:00.000Z");
      return new Response(JSON.stringify({ data: { issues: { nodes: [linearIssue()] } } }), { status: 200 });
    });
    const client = createLinearClient({ http: { fetch } as any, url: "https://api.linear.test/graphql", token: "lin-token" });

    const issues = await client.listCandidateIssues({ stateNames: ["Todo"], first: 1, updatedAfter: "2026-06-01T00:00:00.000Z" });

    expect(issues).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes config defaults", () => {
    expect(readConfig({}).candidateStatusNames).toEqual(["Triage"]);
    expect(readConfig({ maxIssuesPerRun: 1000 }).maxIssuesPerRun).toBe(100);
  });

  it("fails config validation unless enabled intake is Triage-only and has a triage agent", async () => {
    const rejected = await plugin.definition.onValidateConfig?.({
      enabled: true,
      companyId: "company-1",
      linearApiKeySecretRef: "secret-ref",
      candidateStatusNames: ["Backlog", "Todo"],
    });
    expect(rejected).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringMatching(/triageAgentId is required/),
        expect.stringMatching(/must contain only Triage/),
      ]),
    });

    await expect(plugin.definition.onValidateConfig?.({
      enabled: true,
      companyId: "company-1",
      linearApiKeySecretRef: "secret-ref",
      triageAgentId: "chief-of-staff",
      candidateStatusNames: ["Triage"],
    })).resolves.toMatchObject({ ok: true, errors: [] });
  });

  it("admits Triage only and rejects Backlog/Todo even when configuration drifts", () => {
    const config = readConfig({ candidateStatusNames: ["Triage", "Backlog", "Todo"] });
    expect(isCandidateLinearIssue(linearIssue({ state: { name: "Triage" } }), config)).toBe(true);
    expect(isCandidateLinearIssue(linearIssue({ state: { name: "Backlog" } }), config)).toBe(false);
    expect(isCandidateLinearIssue(linearIssue({ state: { name: "Todo" } }), config)).toBe(false);
    expect(isCandidateLinearIssue(linearIssue({ state: { name: "Done" } }), config)).toBe(false);
  });

  it("runs positive and negative intake canaries without creating rejected work", async () => {
    const { host, issues } = fakeHost();
    const linear = fakeLinear([
      linearIssue(),
      linearIssue({ id: "lin-backlog", identifier: "TAN-N1", state: { name: "Backlog" }, description: contractDescription("lin-backlog") }),
      linearIssue({ id: "lin-todo", identifier: "TAN-N2", state: { name: "Todo" }, description: contractDescription("lin-todo") }),
      linearIssue({ id: "lin-invalid", identifier: "TAN-N3", state: { name: "Triage" }, description: "No contract" }),
    ]);
    const summary = await runLinearSync({
      host,
      linear,
      companyId: "company-1",
      config: readConfig({ enabled: true, linearApiKeySecretRef: "LINEAR", triageAgentId: "chief-of-staff", candidateStatusNames: ["Triage", "Backlog", "Todo"] }),
      triggerKind: "manual",
    });

    expect(summary).toMatchObject({ importedCount: 1, contractRejectedCount: 1, failedCount: 0 });
    expect(summary.contractRejections).toEqual([
      expect.objectContaining({
        linearIssueId: "lin-invalid",
        linearIdentifier: "TAN-N3",
        reason: expect.stringMatching(/missing|contract/i),
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ originId: "lin-1", status: "todo" });
    expect(host.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("evaluates delivery evidence and reconciles misleading done states", () => {
    const contract = workContract();
    expect(parseWorkContract(contractDescription())).toEqual({ valid: true, contract });
    expect(evaluateCompletion(contract, {
      deliveryState: "local_artifact_untracked",
      receipts: [{ kind: "comment", ref: "tracker-comment" }],
    })).toMatchObject({ complete: false, missingReceipts: ["test"] });

    expect(reconcileWorkState({
      workId: contract.workId,
      linearState: "Done",
      admissionReceipt: "linear-triage:lin-1",
      paperclipState: "done",
      claimedDeliveryState: "deployed",
      contract,
      evidence: { deliveryState: "local_commit_reviewable", receipts: [{ kind: "test", ref: "vitest:pass" }] },
    })).toMatchObject({
      truthfulState: "state_conflict",
      actualDeliveryState: "local_commit_reviewable",
      conflicts: expect.arrayContaining([expect.stringMatching(/claimed delivery deployed exceeds evidenced delivery/)]),
    });

    expect(reconcileWorkState({
      workId: contract.workId,
      linearState: "Triage",
      paperclipState: null,
      contract: null,
      evidence: { deliveryState: "defined", receipts: [] },
    })).toMatchObject({ admitted: false, truthfulState: "not_admitted" });

    expect(reconcileWorkState({
      workId: contract.workId,
      linearState: "Done",
      admissionReceipt: "linear-triage:lin-1",
      paperclipState: "done",
      contract: null,
      evidence: { deliveryState: "defined", receipts: [] },
    })).toMatchObject({
      truthfulState: "state_conflict",
      conflicts: expect.arrayContaining(["terminal tracker state has no work contract to evaluate"]),
    });
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

  it("normalizes inventory records deterministically", () => {
    expect(normalizePortfolioProject({ id: "p1", name: "Proj", url: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", state: "planned", lead: null, creator: null })).toMatchObject({ kind: "project", sourceKind: "linear", sourceId: "p1", name: "Proj", truth: { url: "unknown", assignee: "unknown", execution: "unknown" } });
    expect(normalizePortfolioIssue({ id: "i1", identifier: "TAN-9", title: "Issue", url: null, createdAt: null, updatedAt: null, state: null, assignee: null, creator: null, project: null })).toMatchObject({ kind: "issue", sourceKind: "linear", sourceId: "i1", title: "Issue", truth: { url: "unknown", state: "unknown", execution: "unknown" } });
  });

  it("combines inventory with exact denominators and state counts", () => {
    const snapshot = combinePortfolioInventory([
      { id: "p1", name: "Proj", url: null, createdAt: null, updatedAt: null, state: "planned", lead: null, creator: null },
    ], [
      { id: "i1", identifier: "TAN-1", title: "Issue", url: null, createdAt: null, updatedAt: null, state: { id: null, name: "Todo" }, assignee: { id: "a1", name: "Alice" }, creator: null, project: null },
    ], { source: { kind: "linear", label: "Linear", host: "api.linear.app", availability: "available" }, pageSize: 100, maxPages: 50, maxRecords: 5000 });
    expect(snapshot.denominators).toEqual({ projects: 1, issues: 1, records: 2 });
    expect(snapshot.stateCounts).toEqual({ projects: { planned: 1 }, issues: { Todo: 1 } });
    expect(snapshot.externalMutations).toBe(0);
    expect(snapshot.sources.github.availability).toBe("unavailable");
  });

  it("treats assignment as assignment, not execution", () => {
    const normalized = normalizePortfolioIssue({ id: "i2", identifier: "TAN-2", title: "Assigned but not running", url: null, createdAt: null, updatedAt: null, state: { id: "todo", name: "Todo" }, assignee: { id: "agent-1", name: "Agent One" }, creator: null, project: null });
    expect(normalized.state).toBe("Todo");
    expect(normalized.truth.assignee).toBe("known");
    expect(normalized.execution).toEqual({ status: "unknown", evidence: [], reason: "assignment_is_not_execution_evidence" });
  });

  it("collects inventory without invoking Linear mutation methods", async () => {
    const linear = fakeLinear([]);
    linear.listAllProjects = vi.fn(async () => ({ records: [], pageCount: 1, pageSize: 100, truncated: false as const }));
    linear.listAllIssues = vi.fn(async () => ({ records: [], pageCount: 1, pageSize: 100, truncated: false as const }));

    const snapshot = await collectPortfolioInventory(linear, {
      source: { kind: "linear", label: "Linear", host: "api.linear.app", availability: "available" },
      pageSize: 100,
      maxPages: 50,
      maxRecords: 5000,
    });

    expect(snapshot.externalMutations).toBe(0);
    expect(linear.postImportComment).not.toHaveBeenCalled();
    expect(linear.moveIssueToState).not.toHaveBeenCalled();
  });

  it("exposes company-scoped routes with path companyResolution only", () => {
    const companyRoutes = (manifest.apiRoutes ?? []).filter((route) => String(route.path).includes(":companyId"));
    expect(companyRoutes.length).toBeGreaterThanOrEqual(4);
    for (const route of companyRoutes) {
      expect(route.companyResolution).toEqual({ from: "path", param: "companyId" });
    }
  });

  it("exposes a read-only portfolio inventory route with no mutation surfaces", async () => {
    expect(manifest.apiRoutes?.filter((route) => route.routeKey === API_ROUTE_KEYS.portfolioInventory)).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/companies/:companyId/portfolio-inventory",
        companyResolution: { from: "path", param: "companyId" },
      }),
    ]);
    expect(manifest.jobs?.map((job) => job.jobKey)).toEqual(["poll-linear-intake"]);
    const harness = createTestHarness({ manifest, config: { enabled: true, companyId: "company-1", linearApiKeySecretRef: "LINEAR" } });
    harness.ctx.secrets.resolve = vi.fn(async () => "token");
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(body.query).includes("projects(first:")) {
        return new Response(JSON.stringify({ data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 });
      }
      if (String(body.query).includes("issues(first:")) {
        return new Response(JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 });
      }
      throw new Error("unexpected query");
    });
    harness.ctx.http.fetch = fetch as any;
    const mutationSpies = [
      vi.spyOn(harness.ctx.db, "execute"),
      vi.spyOn(harness.ctx.state, "set"),
      vi.spyOn(harness.ctx.issues, "create"),
      vi.spyOn(harness.ctx.issues, "update"),
      vi.spyOn(harness.ctx.issues, "requestWakeup"),
      vi.spyOn(harness.ctx.activity, "log"),
      vi.spyOn(harness.ctx.metrics, "write"),
      vi.spyOn(harness.ctx.telemetry, "track"),
    ];
    await plugin.definition.setup(harness.ctx);
    const response = await plugin.definition.onApiRequest?.({ routeKey: API_ROUTE_KEYS.portfolioInventory, method: "GET", path: "/companies/company-1/portfolio-inventory", params: { companyId: "company-1" }, query: {}, body: null, actor: { actorType: "user", actorId: "u1", userId: "u1", agentId: null, runId: null }, companyId: "company-1", headers: {} });
    expect(response?.status).toBe(200);
    expect((response?.body as any).externalMutations).toBe(0);
    expect((response?.body as any).mode).toBe("read_only");
    expect((response?.body as any).sources).toMatchObject({
      linear: { availability: "available" },
      paperclip: { availability: "unavailable" },
      github: { availability: "unavailable" },
      sessionPresence: { availability: "unavailable" },
    });
    expect(harness.dbExecutes).toHaveLength(0);
    expect(harness.activity).toHaveLength(0);
    expect(harness.metrics).toHaveLength(0);
    expect(harness.telemetry).toHaveLength(0);
    for (const spy of mutationSpies) expect(spy).not.toHaveBeenCalled();
    const queries = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).query as string);
    expect(queries.every((q) => q.includes("query") && !q.includes("mutation") && q.includes("includeArchived: true"))).toBe(true);
    expect(queries.every((q) => !q.includes("email"))).toBe(true);

    const rejected = await plugin.definition.onApiRequest?.({ routeKey: API_ROUTE_KEYS.portfolioInventory, method: "POST", path: "/companies/company-1/portfolio-inventory", params: { companyId: "company-1" }, query: {}, body: null, actor: { actorType: "user", actorId: "u1", userId: "u1", agentId: null, runId: null }, companyId: "company-1", headers: {} });
    expect(rejected?.status).toBe(405);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("pages projects and issues until completion and fails closed on cursor problems", async () => {
    const pages = new Map<string, Response>([
      ["projects:START", new Response(JSON.stringify({ data: { projects: { nodes: [{ id: "p1", name: "P1", description: null, url: null, createdAt: null, updatedAt: null, state: null, lead: null, creator: null }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } }), { status: 200 })],
      ["projects:c1", new Response(JSON.stringify({ data: { projects: { nodes: [{ id: "p2", name: "P2", description: null, url: null, createdAt: null, updatedAt: null, state: null, lead: null, creator: null }], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 })],
      ["issues:START", new Response(JSON.stringify({ data: { issues: { nodes: [{ id: "i1", title: "I1" }], pageInfo: { hasNextPage: true, endCursor: "i-c1" } } } }), { status: 200 })],
      ["issues:i-c1", new Response(JSON.stringify({ data: { issues: { nodes: [{ id: "i2", title: "I2" }], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 })],
    ]);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const query = String(body.query);
      const key = query.includes("projects(first:") ? `projects:${body.variables.after ?? "START"}` : `issues:${body.variables.after ?? "START"}`;
      const response = pages.get(key);
      if (!response) throw new Error(`missing page for ${key}`);
      return response.clone();
    });
    const client = createLinearClient({ http: { fetch } as any, url: "https://api.linear.app/graphql", token: "token" });
    await expect(client.listAllProjects({ pageSize: 1 })).resolves.toMatchObject({ records: [{ id: "p1" }, { id: "p2" }], truncated: false });
    await expect(client.listAllIssues({ pageSize: 1 })).resolves.toMatchObject({ records: [{ id: "i1" }, { id: "i2" }], pageCount: 2 });
  });

  it("clamps page size and fails closed on a missing cursor", async () => {
    const firstValues: number[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      firstValues.push(body.variables.first);
      return new Response(JSON.stringify({ data: { projects: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } }), { status: 200 });
    });
    const client = createLinearClient({ http: { fetch } as any, url: "https://api.linear.app/graphql", token: "token" });
    await expect(client.listAllProjects({ pageSize: 0, maxPages: 1, maxRecords: 1 })).rejects.toThrow(/missing an end cursor/i);
    await expect(client.listAllProjects({ pageSize: 1000, maxPages: 1, maxRecords: 1 })).rejects.toThrow(/missing an end cursor/i);
    expect(firstValues).toEqual([1, 100]);
  });

  it("fails closed on repeated cursors and max-pages truncation", async () => {
    const repeatedFetch = vi.fn(async () => new Response(JSON.stringify({ data: { projects: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } }), { status: 200 }));
    const repeatedClient = createLinearClient({ http: { fetch: repeatedFetch } as any, url: "https://api.linear.app/graphql", token: "token" });
    await expect(repeatedClient.listAllProjects({ maxPages: 3 })).rejects.toThrow(/repeated cursor/i);

    let page = 0;
    const boundedFetch = vi.fn(async () => {
      page += 1;
      return new Response(JSON.stringify({ data: { projects: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `c${page}` } } } }), { status: 200 });
    });
    const boundedClient = createLinearClient({ http: { fetch: boundedFetch } as any, url: "https://api.linear.app/graphql", token: "token" });
    await expect(boundedClient.listAllProjects({ maxPages: 2 })).rejects.toThrow(/maxPages=2/i);
    expect(boundedFetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed on max-records truncation and duplicate source ids", async () => {
    const recordsFetch = vi.fn(async () => new Response(JSON.stringify({ data: { projects: { nodes: [
      { id: "p1", name: "P1" }, { id: "p2", name: "P2" },
    ], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 }));
    const recordsClient = createLinearClient({ http: { fetch: recordsFetch } as any, url: "https://api.linear.app/graphql", token: "token" });
    await expect(recordsClient.listAllProjects({ maxRecords: 1 })).rejects.toThrow(/maxRecords=1/i);

    const duplicateFetch = vi.fn(async () => new Response(JSON.stringify({ data: { projects: { nodes: [
      { id: "p1", name: "P1" }, { id: "p1", name: "P1 duplicate" },
    ], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 }));
    const duplicateClient = createLinearClient({ http: { fetch: duplicateFetch } as any, url: "https://api.linear.app/graphql", token: "token" });
    await expect(duplicateClient.listAllProjects()).rejects.toThrow(/duplicate source id p1/i);
  });
});
