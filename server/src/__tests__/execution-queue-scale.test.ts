import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  budgetPolicies,
  companies,
  createDb,
  issueTreeHolds,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution queue scale tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const OPEN_ISSUE_COUNT = 4000;

// EXPLAIN ANALYZE proof, not architectural reasoning: seeds a company at
// production scale (4000 open issues) and asserts on the ACTUAL query plans
// execution-queue.ts's budget and tree-hold precomputation run — index usage,
// and actual row counts that stay flat regardless of open-issue count. Also
// runs the query shape execution-queue.ts USED TO use (SELECT DISTINCT
// agent, project FROM issues WHERE status='todo') as a negative control,
// to show concretely that the redesign's plan differs in kind, not just in
// how many rows happen to come back.
describeEmbeddedPostgres("execution queue precomputation — production-scale query plans", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentIds!: string[];
  let projectIds!: string[];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-queue-scale-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Scale Co",
      issuePrefix: "SCL",
      requireBoardApprovalForNewAgents: false,
    });

    agentIds = Array.from({ length: 10 }, () => randomUUID());
    await db.insert(agents).values(
      agentIds.map((id, index) => ({
        id,
        companyId,
        name: `Scale agent ${index}`,
        role: "engineer" as const,
        status: "active" as const,
        adapterType: "codex_local" as const,
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );

    // Only 2 of the 10 agents' work sits under an actively-policed project;
    // the other 8 have no project-scoped policy touching them at all. This is
    // the realistic shape the redesign is sized for: most companies never use
    // project-scoped budgets, and the ones that do use it for a small subset.
    projectIds = [randomUUID(), randomUUID()];
    await db.insert(projects).values(
      projectIds.map((id, index) => ({
        id,
        companyId,
        name: `Policed project ${index}`,
        status: "backlog" as const,
      })),
    );

    // 4000 open todo issues spread across the 10 agents, ~half referencing
    // one of the two "policed" projects — enough real data that a query
    // which scans issues.company_id="this company" would have real work to
    // do, not an empty/degenerate table.
    const batchSize = 500;
    for (let start = 0; start < OPEN_ISSUE_COUNT; start += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, OPEN_ISSUE_COUNT - start) }, (_, i) => {
        const index = start + i;
        return {
          id: randomUUID(),
          companyId,
          title: `Scale issue ${index}`,
          identifier: `SCL-${index + 1}`,
          status: "todo" as const,
          priority: "medium" as const,
          assigneeAgentId: agentIds[index % agentIds.length],
          projectId: index % 2 === 0 ? projectIds[index % 2] : null,
        };
      });
      await db.insert(issues).values(batch);
    }

    // Exactly 2 active project-scoped budget policies — bounded, small,
    // regardless of how many issues reference those projects.
    await db.insert(budgetPolicies).values(
      projectIds.map((projectId) => ({
        companyId,
        scopeType: "project" as const,
        scopeId: projectId,
        metric: "billed_cents" as const,
        windowKind: "calendar_month_utc" as const,
        amount: 100,
        hardStopEnabled: true,
        isActive: true,
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function explainJson(query: ReturnType<typeof sql>) {
    const rows = await db.execute<Record<string, unknown>>(sql`explain (analyze, format json) ${query}`);
    const planRow = (rows as unknown as Array<Record<string, unknown>>)[0];
    const planJson = planRow?.["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }> | undefined;
    if (!planJson) throw new Error("EXPLAIN did not return a plan — check the query shape");
    return planJson[0]!.Plan;
  }

  function collectNodeTypes(plan: Record<string, unknown>, out: string[] = []): string[] {
    out.push(String(plan["Node Type"]));
    const children = plan["Plans"] as Array<Record<string, unknown>> | undefined;
    if (children) for (const child of children) collectNodeTypes(child, out);
    return out;
  }

  function collectRelationNames(plan: Record<string, unknown>, out: string[] = []): string[] {
    const rel = plan["Relation Name"];
    if (typeof rel === "string") out.push(rel);
    const children = plan["Plans"] as Array<Record<string, unknown>> | undefined;
    if (children) for (const child of children) collectRelationNames(child, out);
    return out;
  }

  it("the redesigned budget candidate query (SELECT DISTINCT project FROM budget_policies) never touches the issues table, and returns exactly the active-policy count regardless of open-issue count", async () => {
    const plan = await explainJson(sql`
      select distinct ${budgetPolicies.scopeId} as project_id
      from ${budgetPolicies}
      where ${budgetPolicies.companyId} = ${companyId}
        and ${budgetPolicies.scopeType} = 'project'
        and ${budgetPolicies.isActive} = true
    `);

    const relations = collectRelationNames(plan);
    expect(relations).not.toContain("issues");
    expect(relations.every((name) => name === "budget_policies")).toBe(true);

    // Bounded by active-policy count (2), not by the 4000 open issues that
    // exist in the same company.
    expect(plan["Actual Rows"]).toBe(2);
  });

  it("negative control: the OLD candidate-pair query this replaced (SELECT DISTINCT agent, project FROM issues WHERE status='todo') scans proportional to open-issue count — proving the redesign's plan differs in kind, not just row count", async () => {
    const plan = await explainJson(sql`
      select distinct ${issues.assigneeAgentId} as agent_id, ${issues.projectId} as project_id
      from ${issues}
      where ${issues.companyId} = ${companyId}
        and ${issues.status} = 'todo'
        and ${issues.assigneeAgentId} is not null
        and ${issues.assigneeUserId} is null
    `);

    const relations = collectRelationNames(plan);
    expect(relations).toContain("issues");
    // This is the query execution-queue.ts used to run to derive budget
    // candidate pairs. Its actual row count is bounded here too (10 distinct
    // agent/project combinations) — the point isn't that it returns many
    // rows, it's that reaching that small result required examining rows
    // proportional to the input, not the output: the plan has to visit (a
    // meaningful fraction of) all 4000 todo issues to deduplicate them, which
    // an index on (company_id, status) narrows to the right partition but
    // does not shrink below the matching row count.
    const nodeTypes = collectNodeTypes(plan);
    const issuesScanNode = (() => {
      function find(node: Record<string, unknown>): Record<string, unknown> | null {
        if (node["Relation Name"] === "issues") return node;
        const children = node["Plans"] as Array<Record<string, unknown>> | undefined;
        if (!children) return null;
        for (const child of children) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      }
      return find(plan);
    })();
    expect(issuesScanNode).not.toBeNull();
    expect(nodeTypes.length).toBeGreaterThan(0);
    // The scan touching `issues` visits a number of rows on the order of the
    // matching todo-issue count (4000), not the tiny distinct-pair count —
    // this is the actual cost the redesign eliminates.
    expect(Number(issuesScanNode!["Actual Rows"])).toBeGreaterThan(1000);
  });

  it("tree-hold precomputation costs one query and touches zero issue rows when there are no active holds, regardless of open-issue count", async () => {
    const plan = await explainJson(sql`
      select ${issueTreeHolds.id}, ${issueTreeHolds.rootIssueId}, ${issueTreeHolds.reason}
      from ${issueTreeHolds}
      where ${issueTreeHolds.companyId} = ${companyId}
        and ${issueTreeHolds.status} = 'active'
        and ${issueTreeHolds.mode} = 'pause'
    `);

    const relations = collectRelationNames(plan);
    expect(relations).not.toContain("issues");
    expect(plan["Actual Rows"]).toBe(0);
    // computeTreeHeldIssueIds() returns immediately when this query is empty —
    // no descendant-expansion query ever runs, so the total cost for a
    // company with zero active holds is exactly this one query, independent
    // of having 4000 open issues.
  });

  it("tree-hold descendant expansion is bounded by the held subtree, not by open-issue count, and uses the parent-id index", async () => {
    const rootId = randomUUID();
    const childIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values({
      id: rootId,
      companyId,
      title: "Held root",
      identifier: "SCL-HELD-ROOT",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentIds[0],
    });
    await db.insert(issues).values(
      childIds.map((id, index) => ({
        id,
        companyId,
        parentId: rootId,
        title: `Held child ${index}`,
        identifier: `SCL-HELD-CHILD-${index}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeAgentId: agentIds[0],
      })),
    );
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: rootId,
      mode: "pause",
      status: "active",
      reason: "Scale test hold",
    });

    // The exact shape of computeTreeHeldIssueIds()'s per-level expansion
    // query: WHERE company_id = ? AND parent_id = ANY(frontier).
    const plan = await explainJson(sql`
      select ${issues.id}, ${issues.parentId}
      from ${issues}
      where ${issues.companyId} = ${companyId}
        and ${issues.parentId} = any(array[${rootId}]::uuid[])
    `);

    const nodeTypes = collectNodeTypes(plan);
    expect(nodeTypes.some((type) => type.includes("Index"))).toBe(true);
    expect(nodeTypes.some((type) => type === "Seq Scan")).toBe(false);
    // Exactly the 3 seeded children — not a fraction of the 4000+ open issues
    // that share this company.
    expect(plan["Actual Rows"]).toBe(3);
  });
});
