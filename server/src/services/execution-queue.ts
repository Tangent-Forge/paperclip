import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  heartbeatRuns,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import type {
  ExecutionQueueBucket,
  ExecutionQueueDispatchResult,
  ExecutionQueueEntry,
  ExecutionQueueReason,
  ExecutionQueueSummary,
  InstanceExperimentalSettings,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound } from "../errors.js";
import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";
import { budgetService } from "./budgets.js";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import { logActivity } from "./activity-log.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const ACTIVE_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution"] as const;
// Terminal issues are never dispatchable and can never unblock another issue by
// becoming "more resolved" than they already are, so excluding them at the query
// keeps the classifier's cost proportional to open work, not a company's full
// history. A company here already carries 500+ issues, ~85% of them done/cancelled.
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const VISIBLE_QUEUE_LIMIT = 5;
// Mirrors issue-tree-control.ts's MAX_PAUSE_HOLD_ANCESTOR_DEPTH — the bound on how
// far a pause hold's effect is allowed to propagate down the issue tree.
const MAX_PAUSE_HOLD_DEPTH = 100;
// dispatchNext's per-query page size for its keyset-paginated candidate scan.
// A tuning knob for query shape (small, index-friendly pages), NOT a
// correctness bound — see DISPATCH_CANDIDATE_SCAN_LIMIT for the actual bound.
// If every issue in one page turns out ineligible (WIP-saturated, budget-
// blocked, tree-held, etc.), the scan advances its keyset cursor and fetches
// the next page rather than stopping, so a highly-ranked run of ineligible
// issues can never mask an eligible one further down the queue.
const DISPATCH_CANDIDATE_PAGE_SIZE = 25;
// The hard bound on how many total candidates a single dispatchNext() call is
// willing to examine (lock attempt + fresh re-check), across however many
// pages that takes. Bounded so a pathological burst of concurrent dispatches,
// or a company with hundreds of ineligible todo issues ranked above every
// eligible one, can't turn one HTTP request into an unbounded scan. Unlike
// the old fixed-LIMIT-25 design, hitting this bound before exhausting the
// candidate set is reported as "selection_incomplete" (retryable) — the
// caller should call dispatch-next again, which starts a fresh scan from the
// top — never as "No runnable issue is available", which is reserved for a
// scan that ran to genuine exhaustion (a page came back shorter than
// DISPATCH_CANDIDATE_PAGE_SIZE, proving no more candidate rows exist) and
// found nothing runnable. 500 is 20 pages — generous versus any observed
// company's actual queue depth, while still bounding worst-case work per
// request.
const DISPATCH_CANDIDATE_SCAN_LIMIT = 500;

// A function, not a shared module-level SQL object: embedding the exact same
// `SQL` chunk instance more than once inside a single combined query — e.g.
// once in the select list and again in a WHERE-clause cursor comparison — was
// empirically found to corrupt that query's parameter binding when executed
// inside a transaction (every page of a keyset scan silently returned the
// same rows regardless of the cursor's actual bind values, despite the
// rendered SQL text and params looking correct). Every call site below builds
// a fresh, independent `SQL` object, which does not exhibit that.
function priorityRankSql() {
  return sql<number>`(case ${issues.priority}
  when 'critical' then 0
  when 'high' then 1
  when 'medium' then 2
  else 3 end)`;
}

// Bounded, per-company facts the classifier needs. Every field here is sized
// by agent count, active-budget-policy count, or currently-held-subtree size —
// never by open-issue count. See computeEligibilitySets() for how each is
// derived and buildBucketReasonSql() for how they're applied.
interface EligibilitySets {
  nonInvokableAgentIds: string[];
  invokabilityMessageByAgentId: Map<string, string>;
  wipSaturatedAgentIds: string[];
  budgetBlockedAgentIds: string[];
  budgetBlockedAgentProjectPairs: Array<{ agentId: string; projectId: string }>;
  budgetBlockReasonByAgentId: Map<string, string>;
  budgetBlockReasonByPairKey: Map<string, string>;
  treeHeldIssueIds: string[];
  treeHoldReasonFallback: string | null;
}

// The classification below is a direct SQL translation of the original per-issue
// JS loop, preserving its exact priority order — see the walkthrough in the PR
// description / commit message for the line-by-line mapping. Two deliberate,
// documented departures from the single-issue APIs it replaces:
//
// 1. Nested/overlapping pause holds: the single-issue `getActivePauseHoldGate`
//    returns the NEAREST covering hold (walking up from the issue). This bulk
//    version unions ALL covering holds' descendant sets, so an issue covered by
//    two nested holds is still correctly bucketed as `held`/`tree_hold`, but the
//    specific hold attributed in `detail` may differ. `ExecutionQueueEntry` has
//    no holdId field and only ever surfaces a human-readable reason string, so
//    this has no observable effect on the API's actual output shape.
// 2. Relation `type` is not filtered — matching the original, which also did
//    not filter by type. Preserved exactly, not silently fixed.
function buildBucketReasonSql(eligibility: EligibilitySets) {
  const hasActiveRun = sql`exists (
    select 1 from ${heartbeatRuns} hr
    where hr.company_id = ${issues.companyId}
      and hr.status in (${sql.join(ACTIVE_RUN_STATUSES.map((s) => sql`${s}`), sql`, `)})
      and (
        hr.context_snapshot ->> 'issueId' = ${issues.id}::text
        or hr.id = ${issues.executionRunId}
      )
  )`;
  const hasQueuedWake = sql`exists (
    select 1 from ${agentWakeupRequests} awr
    where awr.company_id = ${issues.companyId}
      and awr.status in (${sql.join(ACTIVE_WAKE_STATUSES.map((s) => sql`${s}`), sql`, `)})
      and awr.payload ->> 'issueId' = ${issues.id}::text
  )`;
  const hasUnresolvedBlocker = sql`exists (
    select 1 from ${issueRelations} ir
    join ${issues} blocker on blocker.id = ir.issue_id
    where ir.related_issue_id = ${issues.id}
      and ir.company_id = ${issues.companyId}
      and blocker.status not in (${sql.join(TERMINAL_ISSUE_STATUSES.map((s) => sql`${s}`), sql`, `)})
  )`;
  const isNonInvokableAgent = eligibility.nonInvokableAgentIds.length > 0
    ? inArray(issues.assigneeAgentId, eligibility.nonInvokableAgentIds)
    : sql`false`;
  const isTreeHeld = eligibility.treeHeldIssueIds.length > 0
    ? inArray(issues.id, eligibility.treeHeldIssueIds)
    : sql`false`;
  // Two-part budget check, neither part scanning issues: a per-agent baseline
  // (company/agent-scope hard-stops, which don't depend on project) plus, only
  // for the rare case a project actually carries its own active policy, a
  // per-(agent, that project) pair. See computeEligibilitySets().
  const isBudgetBlockedBaseline = eligibility.budgetBlockedAgentIds.length > 0
    ? inArray(issues.assigneeAgentId, eligibility.budgetBlockedAgentIds)
    : sql`false`;
  const isBudgetBlockedByProject = eligibility.budgetBlockedAgentProjectPairs.length > 0
    ? sql`(${sql.join(
        eligibility.budgetBlockedAgentProjectPairs.map((pair) =>
          sql`(${issues.assigneeAgentId} = ${pair.agentId} and ${issues.projectId} = ${pair.projectId})`
        ),
        sql` or `,
      )})`
    : sql`false`;
  const isWipSaturatedAgent = eligibility.wipSaturatedAgentIds.length > 0
    ? inArray(issues.assigneeAgentId, eligibility.wipSaturatedAgentIds)
    : sql`false`;

  // Encodes bucket+reason as one "bucket:reason" text column — simplest way to
  // carry a single CASE expression's classification through GROUP BY and ORDER
  // BY without juggling two correlated CASE expressions that must stay in sync.
  return sql<string>`case
    when ${issues.status} = 'backlog' then 'held:backlog'
    when ${issues.status} = 'blocked' then 'blocked:explicit_blocker'
    when ${issues.status} = 'in_review' then 'waiting:review_or_approval'
    when ${issues.status} = 'in_progress' and ${hasActiveRun} then 'waiting:active_execution'
    when ${issues.status} = 'in_progress' and ${hasQueuedWake} then 'waiting:queued_execution'
    when ${issues.status} = 'in_progress' then 'waiting:continuation_requires_recovery'
    when ${issues.assigneeUserId} is not null then 'waiting:human_owned'
    when ${issues.assigneeAgentId} is null then 'blocked:unassigned'
    when ${isNonInvokableAgent} then 'blocked:agent_not_invokable'
    when ${hasActiveRun} then 'waiting:active_execution'
    when ${hasQueuedWake} then 'waiting:queued_execution'
    when ${hasUnresolvedBlocker} then 'blocked:explicit_blocker'
    when ${isTreeHeld} then 'held:tree_hold'
    when ${isBudgetBlockedBaseline} then 'held:budget_blocked'
    when ${isBudgetBlockedByProject} then 'held:budget_blocked'
    when ${isWipSaturatedAgent} then 'waiting:agent_wip_limit'
    else 'runnable:ready'
  end`;
}

function splitBucketReason(value: string): [ExecutionQueueBucket, ExecutionQueueReason] {
  const [bucket, reason] = value.split(":");
  return [bucket as ExecutionQueueBucket, reason as ExecutionQueueReason];
}

// The exact subset of `issues` columns the visible-slice pipeline (buildDetail
// + toEntry) needs, matching what `classifiedIssues()` actually selects.
interface ClassifiedIssueRow {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  companyId: string;
  projectId: string | null;
  updatedAt: Date;
}

export function executionQueueService(
  db: Db,
  deps: {
    // dispatchNext's reservation (selection + lock + run creation) always runs
    // inside its own transaction with the run's own auto-start suppressed —
    // that part isn't optional, it's what keeps the reservation atomic and
    // isolation-safe. This controls only the step AFTER that transaction
    // commits: whether to actually trigger the run's execution. Real callers
    // (the route) want this on, always. Tests without a real adapter to route
    // to want it off, so a fire-and-forget execution attempt can't race their
    // own teardown — the same class of flake autoStartQueuedRuns in
    // heartbeat.ts exists to rule out at the source. Defaults to true.
    autoStartAfterDispatch?: boolean;
    // Test-only synchronization seam: invoked exactly once per dispatchNext()
    // call, right before the claim transaction begins (and therefore before
    // eligibility is computed, since that now happens inside the
    // transaction). Lets a test deterministically commit a concurrent
    // mutation — via a separate connection — into exactly the window a stale,
    // pre-transaction eligibility snapshot would miss but an in-transaction
    // recompute picks up, without depending on real concurrent timing landing
    // there by chance. Never invoked in production — the route's own deps
    // type doesn't expose it. Defaults to a no-op.
    beforeClaimTransactionForTest?: () => Promise<void>;
  } = {},
) {
  const settings = instanceSettingsService(db);

  // Downward expansion from each active pause hold's root, bounded to the same
  // depth as the single-issue upward walk it stands in for. Common case (no
  // active holds — an operational feature that's rarely in use) costs one query
  // and returns immediately, matching issue-tree-control.ts's own fast path.
  // Cost is proportional to the size of the currently-held subtree(s), never to
  // total open-issue count — see execution-queue-scale.test.ts for empirical
  // proof this doesn't degrade as open-issue count grows with zero/few holds.
  async function computeTreeHeldIssueIds(dbOrTx: Db, companyId: string): Promise<{ issueIds: string[]; reasonByRoot: Map<string, string | null> }> {
    const activeHolds = await dbOrTx
      .select({ id: issueTreeHolds.id, rootIssueId: issueTreeHolds.rootIssueId, reason: issueTreeHolds.reason })
      .from(issueTreeHolds)
      .where(and(
        eq(issueTreeHolds.companyId, companyId),
        eq(issueTreeHolds.status, "active"),
        eq(issueTreeHolds.mode, "pause"),
      ))
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));

    const reasonByRoot = new Map(activeHolds.map((hold) => [hold.rootIssueId, hold.reason]));
    if (activeHolds.length === 0) return { issueIds: [], reasonByRoot };

    const held = new Set<string>(activeHolds.map((hold) => hold.rootIssueId));
    let frontier = [...held];
    let depth = 0;
    while (frontier.length > 0 && depth < MAX_PAUSE_HOLD_DEPTH) {
      const children = await dbOrTx
        .select({ id: issues.id, parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, frontier)));
      const next: string[] = [];
      for (const child of children) {
        if (!held.has(child.id)) {
          held.add(child.id);
          next.push(child.id);
        }
      }
      frontier = next;
      depth += 1;
    }
    return { issueIds: [...held], reasonByRoot };
  }

  // Shared by summary() and dispatchNext() so both use the exact same
  // eligibility facts — no separate "what's runnable" logic to drift apart.
  // Callers control freshness via dbOrTx: summary() passes the plain `db`
  // handle (a point-in-time read is what a dashboard view wants), while
  // dispatchNext() passes its claim transaction's own connection, so budget/
  // WIP/tree-hold facts are read from inside the same transaction that will
  // go on to lock and dispatch a candidate — not from a snapshot taken before
  // that transaction even began. Every part of this is bounded by agent
  // count, active-budget-policy count, or held-subtree size, never by
  // open-issue count:
  //   - invokability: pure function over the already-fetched agent list.
  //   - WIP saturation: one GROUP BY over active heartbeat_runs, one row per
  //     agent with an active run.
  //   - budget: a per-agent baseline check (company/agent-scope hard-stops,
  //     which don't depend on project) plus, ONLY for projects that actually
  //     carry an active project-scoped policy (queried directly from
  //     budget_policies, never from issues), a per-(agent, that project)
  //     check. Previously this was `SELECT DISTINCT agent, project FROM
  //     issues WHERE status='todo'`, which scans every open todo issue to
  //     compute its DISTINCT set regardless of how few rows the set contains —
  //     the row count returned was small, but the scan cost wasn't. This
  //     version never touches the issues table for candidate derivation.
  //   - tree hold: see computeTreeHeldIssueIds.
  async function computeEligibilitySets(
    dbOrTx: Db,
    companyId: string,
    experimental: InstanceExperimentalSettings,
    companyAgents: AgentOrgRow[],
  ): Promise<EligibilitySets> {
    // Bound to dbOrTx, not the outer `db` closure, so a caller inside a claim
    // transaction (dispatchNext) gets a budget service scoped to that same
    // transaction — every check below then reads this transaction's own view
    // of committed state, not a connection/point-in-time separate from the
    // lock it's about to take.
    const budgets = budgetService(dbOrTx);

    const nonInvokableAgentIds: string[] = [];
    const invokabilityMessageByAgentId = new Map<string, string>();
    for (const agent of companyAgents) {
      const invokability = evaluateAgentInvokability(agent, companyAgents);
      if (!invokability.invokable) {
        nonInvokableAgentIds.push(agent.id);
        invokabilityMessageByAgentId.set(agent.id, invokability.message);
      }
    }

    const wipCounts = await dbOrTx
      .select({ agentId: heartbeatRuns.agentId, count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES])))
      .groupBy(heartbeatRuns.agentId);
    const wipSaturatedAgentIds = wipCounts
      .filter((row) => row.count >= experimental.executionQueueMaxActiveRunsPerAgent)
      .map((row) => row.agentId);

    const budgetBlockedAgentIds: string[] = [];
    const budgetBlockReasonByAgentId = new Map<string, string>();
    for (const agent of companyAgents) {
      const block = await budgets.getInvocationBlock(companyId, agent.id, { projectId: null });
      if (block) {
        budgetBlockedAgentIds.push(agent.id);
        budgetBlockReasonByAgentId.set(agent.id, block.reason);
      }
    }

    const projectPolicyRows = await dbOrTx
      .selectDistinct({ projectId: budgetPolicies.scopeId })
      .from(budgetPolicies)
      .where(and(
        eq(budgetPolicies.companyId, companyId),
        eq(budgetPolicies.scopeType, "project"),
        eq(budgetPolicies.isActive, true),
      ));
    const budgetBlockedAgentProjectPairs: Array<{ agentId: string; projectId: string }> = [];
    const budgetBlockReasonByPairKey = new Map<string, string>();
    if (projectPolicyRows.length > 0) {
      for (const agent of companyAgents) {
        // Baseline block already covers every project for this agent — no
        // point spending a query confirming what's already established.
        if (budgetBlockedAgentIds.includes(agent.id)) continue;
        for (const { projectId } of projectPolicyRows) {
          const block = await budgets.getInvocationBlock(companyId, agent.id, { projectId });
          if (block) {
            budgetBlockedAgentProjectPairs.push({ agentId: agent.id, projectId });
            budgetBlockReasonByPairKey.set(`${agent.id}|${projectId}`, block.reason);
          }
        }
      }
    }

    const { issueIds: treeHeldIssueIds, reasonByRoot } = await computeTreeHeldIssueIds(dbOrTx, companyId);
    const treeHoldReasonFallback = [...reasonByRoot.values()].find((reason) => reason) ?? null;

    return {
      nonInvokableAgentIds,
      invokabilityMessageByAgentId,
      wipSaturatedAgentIds,
      budgetBlockedAgentIds,
      budgetBlockedAgentProjectPairs,
      budgetBlockReasonByAgentId,
      budgetBlockReasonByPairKey,
      treeHeldIssueIds,
      treeHoldReasonFallback,
    };
  }

  async function fetchCompanyAgents(dbOrTx: Db, companyId: string): Promise<AgentOrgRow[]> {
    return dbOrTx
      .select({ id: agents.id, companyId: agents.companyId, name: agents.name, reportsTo: agents.reportsTo, status: agents.status })
      .from(agents)
      .where(eq(agents.companyId, companyId));
  }

  async function summary(companyId: string): Promise<ExecutionQueueSummary> {
    const [company, experimental] = await Promise.all([
      db.select().from(companies).where(eq(companies.id, companyId)).then((rows) => rows[0] ?? null),
      settings.getExperimental(),
    ]);
    if (!company) throw notFound("Company not found");

    const emptyCounts = { runnable: 0, waiting: 0, blocked: 0, held: 0 };
    const baseResult = {
      companyId,
      mode: experimental.executionQueueMode,
      maxActiveRunsPerAgent: experimental.executionQueueMaxActiveRunsPerAgent,
      generatedAt: new Date().toISOString(),
    };

    // A paused/archived company holds every open issue, unconditionally — no
    // agent, budget, blocker, or hold classification is relevant, so this short
    // circuits to a single count query and one bounded visible-list query.
    if (company.status !== "active") {
      const [totalRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES])));
      const total = totalRow?.count ?? 0;
      const visibleRows = total === 0 ? [] : await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES])))
        .orderBy(asc(priorityRankSql()), asc(issues.updatedAt), asc(issues.id))
        .limit(VISIBLE_QUEUE_LIMIT);
      const agentIds = [...new Set(visibleRows.map((row) => row.assigneeAgentId).filter((id): id is string => Boolean(id)))];
      const agentNameById = agentIds.length === 0 ? new Map<string, string>() : new Map(
        (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)))
          .map((row) => [row.id, row.name]),
      );
      const held = visibleRows.map((issue) => toEntry(issue, agentNameById.get(issue.assigneeAgentId ?? "") ?? null, "held", "company_inactive", "Company is paused or archived."));
      return {
        ...baseResult,
        counts: { ...emptyCounts, held: total },
        runnable: [],
        waiting: [],
        blocked: [],
        held,
      };
    }

    const companyAgents = await fetchCompanyAgents(db, companyId);
    const agentNameById = new Map(companyAgents.map((agent) => [agent.id, agent.name]));
    const eligibility = await computeEligibilitySets(db, companyId, experimental, companyAgents);

    const baseFilter = and(eq(issues.companyId, companyId), notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]));

    // The classification CASE is written once here and computed once per query
    // by Postgres inside this subquery; every outer query below references it
    // by the plain `bucketReason` column name, never by re-rendering the CASE
    // itself — GROUP BY / WHERE / ORDER BY on a re-rendered copy of the same
    // expression is what Postgres actually rejects ("must appear in the GROUP
    // BY clause"), even when the two renderings are textually identical.
    //
    // Columns are selected individually rather than as `issue: issues` — a
    // whole embedded table object doesn't carry a usable per-column alias once
    // wrapped in `.as()`, so referencing e.g. `classified.issue.id` from an
    // outer query fails ("table issues is not part of the query").
    function classifiedIssues() {
      return db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          companyId: issues.companyId,
          projectId: issues.projectId,
          updatedAt: issues.updatedAt,
          bucketReason: buildBucketReasonSql(eligibility).as("bucket_reason"),
          priorityRank: priorityRankSql().as("priority_rank"),
        })
        .from(issues)
        .where(baseFilter)
        .as("classified");
    }

    const classifiedForCounts = classifiedIssues();
    const countRows = await db
      .select({ bucketReason: classifiedForCounts.bucketReason, count: sql<number>`count(*)::int` })
      .from(classifiedForCounts)
      .groupBy(classifiedForCounts.bucketReason);
    const counts = { ...emptyCounts };
    for (const row of countRows) {
      const [bucket] = splitBucketReason(row.bucketReason);
      counts[bucket] += row.count;
    }

    const buckets: Record<ExecutionQueueBucket, ExecutionQueueEntry[]> = { runnable: [], waiting: [], blocked: [], held: [] };
    for (const bucket of Object.keys(buckets) as ExecutionQueueBucket[]) {
      const classified = classifiedIssues();
      const visibleRows = await db
        .select()
        .from(classified)
        .where(sql`${classified.bucketReason} like ${bucket + ":%"}`)
        .orderBy(asc(classified.priorityRank), asc(classified.updatedAt), asc(classified.id))
        .limit(VISIBLE_QUEUE_LIMIT);

      // Detail text is regenerated only for the bounded visible slice (at most
      // VISIBLE_QUEUE_LIMIT per bucket), reusing the same messages/formatting
      // the original per-issue loop produced — never recomputed for the full
      // open-issue set.
      for (const issue of visibleRows) {
        const [, reason] = splitBucketReason(issue.bucketReason);
        const agentName = issue.assigneeAgentId ? agentNameById.get(issue.assigneeAgentId) ?? null : null;
        const detail = await buildDetail(issue, reason, eligibility);
        buckets[bucket].push(toEntry(issue, agentName, bucket, reason, detail));
      }
    }

    return {
      ...baseResult,
      counts,
      runnable: buckets.runnable,
      waiting: buckets.waiting,
      blocked: buckets.blocked,
      held: buckets.held,
    };
  }

  // Only ever called for the bounded visible slice (≤ VISIBLE_QUEUE_LIMIT per
  // bucket), so the extra blocker-identifier lookup below costs at most a
  // handful of small queries per summary() call, not one per open issue.
  async function buildDetail(
    issue: ClassifiedIssueRow,
    reason: ExecutionQueueReason,
    eligibility: EligibilitySets,
  ): Promise<string> {
    switch (reason) {
      case "backlog":
        return "Backlog is intentionally parked and is not dispatchable.";
      case "review_or_approval":
        return "Waiting for a reviewer, approval, or explicit handoff.";
      case "active_execution":
        return "Work is already executing.";
      case "queued_execution":
        return "A wake is already queued for this issue.";
      case "continuation_requires_recovery":
        return "Active work needs its explicit continuation/recovery path, not a second queue pickup.";
      case "human_owned":
        return "A human owns the next action.";
      case "unassigned":
        return "No agent owns this actionable issue.";
      case "agent_not_invokable":
        return (issue.assigneeAgentId && eligibility.invokabilityMessageByAgentId.get(issue.assigneeAgentId))
          ?? "Assignee is not currently invokable.";
      case "explicit_blocker": {
        if (issue.status === "blocked") {
          return "Issue is explicitly blocked; the next action must be made visible.";
        }
        const blockers = await db
          .select({ identifier: issues.identifier, id: issues.id })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.issueId, issues.id))
          .where(and(
            eq(issueRelations.relatedIssueId, issue.id),
            eq(issueRelations.companyId, issue.companyId),
            notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
          ));
        const names = blockers.map((blocker) => blocker.identifier ?? blocker.id);
        return names.length > 0 ? `Waiting on ${names.join(", ")}.` : "Waiting on an unresolved blocker.";
      }
      case "tree_hold":
        return eligibility.treeHoldReasonFallback ?? "A tree pause hold is active.";
      case "budget_blocked": {
        if (issue.assigneeAgentId) {
          const baseline = eligibility.budgetBlockReasonByAgentId.get(issue.assigneeAgentId);
          if (baseline) return baseline;
          if (issue.projectId) {
            const pairKey = `${issue.assigneeAgentId}|${issue.projectId}`;
            const perProject = eligibility.budgetBlockReasonByPairKey.get(pairKey);
            if (perProject) return perProject;
          }
        }
        return "The assignee's budget hard-stop is exceeded.";
      }
      case "agent_wip_limit":
        return "The assignee has reached the controlled work-in-progress limit.";
      case "company_inactive":
        return "Company is paused or archived.";
      case "ready":
      default:
        return "Ready for one controlled, issue-scoped dispatch.";
    }
  }

  function toEntry(
    issue: ClassifiedIssueRow,
    agentName: string | null,
    bucket: ExecutionQueueBucket,
    reason: ExecutionQueueReason,
    detail: string,
  ): ExecutionQueueEntry {
    return {
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeName: agentName,
      bucket,
      reason,
      detail,
      updatedAt: issue.updatedAt.toISOString(),
    };
  }

  interface CandidateCursor {
    priorityRank: number;
    // The raw, full-precision Postgres text representation of updatedAt (e.g.
    // "2026-08-24 13:41:57.777123-05"), not a JS Date. Postgres timestamps
    // carry microsecond precision; JS Date only carries milliseconds — round-
    // tripping through a Date (parse, then .toISOString()) silently truncates
    // the sub-millisecond digits, making the cursor compare as *earlier* than
    // the exact row that produced it. When several rows share one timestamp
    // (routine for a batch insert, where every row gets the same statement-
    // time `now()`), that truncation makes every one of them satisfy
    // `updated_at > cursor` again — the row a page's cursor was built from,
    // and every row tied with it, keeps reappearing on every later page
    // instead of being excluded, so the scan never advances past that tie.
    // Keeping and comparing the untruncated text avoids the loss entirely.
    updatedAtRaw: string;
    id: string;
  }

  // Cheap, narrow page — NOT the full classification. Only issues that could
  // possibly be runnable at all (todo, agent-assigned, no human owner) are
  // candidates; the expensive per-row EXISTS-based classification only runs
  // once each candidate is actually examined inside the claim loop below.
  //
  // Keyset-paginated via `cursor`: passing the previous page's last row keeps
  // this a plain indexed range scan (never an OFFSET-based scan that gets more
  // expensive the deeper it pages) and, combined with the caller looping until
  // a page comes back shorter than DISPATCH_CANDIDATE_PAGE_SIZE, guarantees
  // every matching row is eventually reachable — a run of ineligible issues at
  // the top of the ranking can no longer hide an eligible one further down.
  async function selectCandidateIssueIds(
    tx: Db,
    companyId: string,
    cursor: CandidateCursor | null,
  ): Promise<Array<{ id: string; assigneeAgentId: string; updatedAt: Date; updatedAtRaw: string; priorityRank: number }>> {
    // The standard three-clause OR keyset-pagination predicate (rank strictly
    // greater; OR rank tied and updatedAt strictly greater; OR both tied and
    // id strictly greater), matching the (priorityRank asc, updatedAt asc, id
    // asc) ORDER BY below exactly. Compares against cursor.updatedAtRaw (full
    // Postgres precision), never a round-tripped JS Date — see
    // CandidateCursor's own comment for why that distinction is load-bearing
    // here specifically, not just a style preference.
    const cursorFilter = cursor
      ? sql`and (
          (${priorityRankSql()}) > ${cursor.priorityRank}
          or ((${priorityRankSql()}) = ${cursor.priorityRank} and ${issues.updatedAt} > ${cursor.updatedAtRaw}::timestamptz)
          or ((${priorityRankSql()}) = ${cursor.priorityRank} and ${issues.updatedAt} = ${cursor.updatedAtRaw}::timestamptz and ${issues.id} > ${cursor.id}::uuid)
        )`
      : sql``;
    const rows = await tx.execute<{ id: string; assignee_agent_id: string | null; updated_at: string; priority_rank: number }>(sql`
      select ${issues.id} as id, ${issues.assigneeAgentId} as assignee_agent_id, ${issues.updatedAt} as updated_at,
        (${priorityRankSql()}) as priority_rank
      from ${issues}
      where ${issues.companyId} = ${companyId}
        and ${issues.status} = 'todo'
        and ${issues.assigneeAgentId} is not null
        and ${issues.assigneeUserId} is null
        ${cursorFilter}
      order by priority_rank asc, ${issues.updatedAt} asc, ${issues.id} asc
      limit ${DISPATCH_CANDIDATE_PAGE_SIZE}
    `);
    return (rows as unknown as Array<{ id: string; assignee_agent_id: string | null; updated_at: string; priority_rank: number }>)
      .filter((row): row is { id: string; assignee_agent_id: string; updated_at: string; priority_rank: number } => Boolean(row.assignee_agent_id))
      .map((row) => ({
        id: row.id,
        assigneeAgentId: row.assignee_agent_id,
        updatedAt: new Date(row.updated_at),
        updatedAtRaw: row.updated_at,
        priorityRank: Number(row.priority_rank),
      }));
  }

  // Re-derives this ONE issue's full classification fresh, using the exact
  // same CASE the board's summary() uses, scoped to a single row — cheap
  // (bounded to one issue), and run only after the candidate loop below has
  // already locked it, so the answer reflects truly current state, not the
  // shortlist snapshot taken before the lock was acquired.
  async function isIssueStillRunnable(tx: Db, companyId: string, issueId: string, eligibility: EligibilitySets): Promise<boolean> {
    const [row] = await tx
      .select({ bucketReason: buildBucketReasonSql(eligibility) })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    return row?.bucketReason === "runnable:ready";
  }

  type ClaimOutcome =
    | { kind: "claimed"; issueId: string; agentId: string; runId: string }
    | { kind: "exhausted" }
    | { kind: "scan_limit_reached"; scanned: number };

  async function dispatchNext(companyId: string): Promise<ExecutionQueueDispatchResult> {
    const experimental = await settings.getExperimental();
    if (experimental.executionQueueMode !== "controlled") {
      throw conflict("Execution queue is in observe mode. Enable controlled mode before dispatching work.");
    }

    // Selection, reservation, and run creation happen inside one transaction so
    // a concurrent dispatchNext() call can never observe (and act on) the same
    // "top runnable issue" this one is still in the middle of claiming.
    //
    // `wakeup()`'s own issue-scoped lock (SELECT ... FOR UPDATE on the issue
    // row, taken whenever contextSnapshot.issueId is set) already re-validates
    // freshness before creating a run — but only via issue.executionRunId,
    // which is deliberately left unset until a queued run actually starts
    // running (heartbeat.ts's own "Fix A: lazy locking" comment), not when
    // it's merely queued. Two dispatchNext() calls racing the same issue could
    // therefore both pass wakeup()'s check and both create a queued run for
    // it — the exact "one truthful dispatch record per selected issue" defect
    // this rewrite closes. The fix is `for update skip locked` on the issue
    // row PLUS a fresh re-classification (via the same CASE the board uses,
    // which — unlike executionRunId — checks contextSnapshot for an existing
    // active/queued run) before calling wakeup(), all nested inside the same
    // transaction wakeup() itself runs in, so its own lock re-acquisition is a
    // safe no-op on a lock this transaction already holds.
    //
    // companyAgents and eligibility (budget/WIP/tree-hold) are both computed
    // AFTER entering the transaction, scoped to it, rather than before — a
    // pre-transaction snapshot can go stale in the gap between being read and
    // the transaction actually starting (network round-trips, connection-pool
    // queueing, a slow prior query), and every candidate examined below would
    // silently reuse that stale answer for the rest of the call. Recomputing
    // here still can't literally lock facts that have no natural row of their
    // own (a budget total, a WIP count) short of SERIALIZABLE isolation, so
    // wakeup() below still performs its own final, independently fresh
    // WIP re-check (row-locked) and budget/tree-hold re-check as the true
    // authoritative gate — this recompute closes the practical staleness
    // window and keeps candidate SELECTION consistent with what wakeup() is
    // actually about to decide, rather than working from a separately-stale
    // view of the same facts.
    await deps.beforeClaimTransactionForTest?.();
    const claimed = await db.transaction(async (tx): Promise<ClaimOutcome> => {
      const scopedTx = tx as unknown as Db;
      const companyAgents = await fetchCompanyAgents(scopedTx, companyId);
      const eligibility = await computeEligibilitySets(scopedTx, companyId, experimental, companyAgents);

      const heartbeatTx = heartbeatService(scopedTx, { autoStartQueuedRuns: false });
      let cursor: CandidateCursor | null = null;
      let scanned = 0;

      while (scanned < DISPATCH_CANDIDATE_SCAN_LIMIT) {
        const page = await selectCandidateIssueIds(scopedTx, companyId, cursor);
        if (page.length === 0) return { kind: "exhausted" };

        for (const candidate of page) {
          scanned += 1;
          cursor = { priorityRank: candidate.priorityRank, updatedAtRaw: candidate.updatedAtRaw, id: candidate.id };
          if (scanned > DISPATCH_CANDIDATE_SCAN_LIMIT) {
            return { kind: "scan_limit_reached", scanned: scanned - 1 };
          }

          const lockRows = await tx.execute(
            sql`select id from issues where id = ${candidate.id} and company_id = ${companyId} for update skip locked`,
          );
          if (lockRows.length === 0) {
            // Already being claimed by a concurrent dispatchNext() transaction —
            // skip it rather than wait, and try the next-best candidate instead.
            continue;
          }

          const stillRunnable = await isIssueStillRunnable(scopedTx, companyId, candidate.id, eligibility);
          if (!stillRunnable) continue;

          const idempotencyKey = `execution-queue:${companyId}:${candidate.id}:${candidate.updatedAt.toISOString()}`;
          try {
            const run = await heartbeatTx.wakeup(candidate.assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "execution_queue_dispatch",
              payload: { issueId: candidate.id, queueMode: "controlled" },
              idempotencyKey,
              requestedByActorType: "system",
              requestedByActorId: null,
              contextSnapshot: {
                issueId: candidate.id,
                source: "execution.queue",
                executionQueueDispatch: true,
              },
            });
            // wakeup()'s own gates (WIP limit, policy, controlled-mode checks) can
            // still reject — e.g. the WIP limit for this agent was hit by a
            // different issue claimed earlier in this same loop.
            if (!run) continue;

            return { kind: "claimed", issueId: candidate.id, agentId: candidate.assigneeAgentId, runId: run.id };
          } catch (error) {
            // wakeup() throws (rather than returning null) for a handful of its
            // own fresh, independently-rechecked gates — budget hard-stop and
            // agent invokability among them (see enqueueWakeup). Those are
            // exactly the same category as an `if (!run) continue` skip from
            // this loop's point of view: this specific candidate was declined
            // for a legitimate, current reason, not a bug. Treating only that
            // narrow class (HttpError, conflict/409) as "skip and try the next
            // candidate" — rather than letting it abort the whole transaction
            // and fail the entire dispatch-next request — is what actually
            // makes a same-instant budget/invokability change (landing after
            // this candidate passed the classifier above but before wakeup()'s
            // own recheck ran) a graceful miss instead of a hard failure.
            if (error instanceof HttpError && error.status === 409) continue;
            throw error;
          }
        }

        // A page shorter than the requested page size means the query had no
        // more matching rows to return — genuine exhaustion, not just "this
        // page's candidates didn't work out". Return immediately rather than
        // spending one more round trip to confirm an empty next page.
        if (page.length < DISPATCH_CANDIDATE_PAGE_SIZE) return { kind: "exhausted" };
      }
      return { kind: "scan_limit_reached", scanned };
    });

    if (claimed.kind === "scan_limit_reached") {
      return {
        disposition: "selection_incomplete",
        issueId: null,
        runId: null,
        reason: `Examined ${claimed.scanned} candidates without finding a dispatchable issue or exhausting the queue. Call dispatch-next again to continue.`,
      };
    }
    if (claimed.kind === "exhausted") {
      return {
        disposition: "not_dispatched",
        issueId: null,
        runId: null,
        reason: "No runnable issue is available.",
      };
    }

    // Only after the transaction above has actually committed — so the queued
    // run is real and visible outside it — trigger the normal "start it" step
    // wakeup() would otherwise have done inline. Doing this before commit would
    // let a fire-and-forget execution attempt run against data that isn't
    // committed yet from another connection's point of view.
    if (deps.autoStartAfterDispatch !== false) {
      await heartbeatService(db).startNextQueuedRunForAgent(claimed.agentId);
    }

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "execution_queue",
      agentId: claimed.agentId,
      runId: claimed.runId,
      action: "execution_queue.dispatched",
      entityType: "issue",
      entityId: claimed.issueId,
      details: {
        queueMode: experimental.executionQueueMode,
        maxActiveRunsPerAgent: experimental.executionQueueMaxActiveRunsPerAgent,
      },
    });
    return {
      disposition: "queued",
      issueId: claimed.issueId,
      runId: claimed.runId,
      reason: "Queued the highest-priority runnable issue.",
    };
  }

  return { summary, dispatchNext };
}
