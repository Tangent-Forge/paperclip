import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  companies,
  createDb,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.js";

// Regression coverage for the Paperclip Inbox "Human Decisions" tab
// (/PAP/inbox/blocked) rendering empty while the Dashboard "Pending Approvals" tile has
// dozens of BOARD APPROVAL cards. Root cause: approvals routed from a stale ledger ask or
// a blocked-with-no-blocker issue (scripts/route_decisions.py) are created with no
// issue_approvals link, so the Issue-driven blocked-inbox attention query in issues.ts
// never surfaces them. `approvalService.list(..., { unlinkedOnly: true })` is the new
// data path the "Human Decisions" tab uses to pick these up directly.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres unlinked-approvals tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("approvalService list({ unlinkedOnly })", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof approvalService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  async function createCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Company AU",
      issuePrefix: "AU",
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approvals-unlinked-");
    db = createDb(tempDb.connectionString);
    svc = approvalService(db);
    companyId = await createCompany();
  }, 20_000);

  // `companyId` is created once in beforeAll and reused across tests — only the
  // per-test rows get reset here.
  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns a pending BOARD APPROVAL routed with no destination, which has no issue_approvals link", async () => {
    const routedApprovalId = randomUUID();
    await db.insert(approvals).values({
      id: routedApprovalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {
        title: "Decide: Run a post-Option-B apply round and report same-session metrics",
        summary: "Routed from board item AU-1 (severity high, waiting 0d). This decision had no destination.",
        source_id: "AU-1",
        source_kind: "board",
        routed_by: "scripts/route_decisions.py",
      },
    });

    const unlinked = await svc.list(companyId, "pending", { unlinkedOnly: true });
    expect(unlinked.map((a) => a.id)).toEqual([routedApprovalId]);
  });

  it("excludes an approval that IS linked to a live issue via issue_approvals", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "AU-2",
      title: "Linked issue",
      status: "blocked",
      priority: "medium",
    });

    const linkedApprovalId = randomUUID();
    await db.insert(approvals).values({
      id: linkedApprovalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {},
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId: linkedApprovalId,
    });

    const unlinkedApprovalId = randomUUID();
    await db.insert(approvals).values({
      id: unlinkedApprovalId,
      companyId,
      type: "budget_override_required",
      status: "pending",
      payload: {},
    });

    const unlinked = await svc.list(companyId, "pending", { unlinkedOnly: true });
    expect(unlinked.map((a) => a.id)).toEqual([unlinkedApprovalId]);

    // Without the filter, both the linked and unlinked approvals are still visible — this
    // is exactly what /approvals/pending (the Dashboard tile) already queries.
    const all = await svc.list(companyId, "pending");
    expect(all.map((a) => a.id).sort()).toEqual([linkedApprovalId, unlinkedApprovalId].sort());
  });

  it("does not return approved/rejected approvals even when unlinked", async () => {
    const resolvedApprovalId = randomUUID();
    await db.insert(approvals).values({
      id: resolvedApprovalId,
      companyId,
      type: "request_board_approval",
      status: "approved",
      payload: {},
    });

    const unlinked = await svc.list(companyId, "pending", { unlinkedOnly: true });
    expect(unlinked).toEqual([]);
  });

  // Guards against a duplicate/stale row surviving in the Human Decisions "orphan" lane:
  // once an approval that started unlinked gets a real issue_approvals row (e.g. an agent
  // or a follow-up router run finally gives it a destination issue), it must disappear
  // from the unlinkedOnly result on the very next read — there is no separate flag to
  // clear, the NOT EXISTS predicate is derived live from issue_approvals every query, so
  // it can never lag behind and cause the approval to render both as an orphan row and as
  // an issue-linked "pending_board_decision" row at the same time.
  it("drops an approval from the unlinked set the moment it gains an issue_approvals link, with no lag", async () => {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Decide: something", source_id: "AU-9" },
    });

    // Before linking: visible as an orphan.
    const beforeLink = await svc.list(companyId, "pending", { unlinkedOnly: true });
    expect(beforeLink.map((a) => a.id)).toEqual([approvalId]);

    // Link it to a live issue — this is exactly what happens when an approval created
    // with issueIds (or later linked via POST /approvals/:id, or a future narrower
    // version of scripts/route_decisions.py) gets a destination.
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "AU-9",
      title: "Now has a destination",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });

    // After linking: gone from the orphan set immediately (no caching/flag to clear), so
    // the Human Decisions tab will only ever show it once — via the issue-linked
    // `pending_board_decision` attention row computed in issues.ts, not via this path too.
    const afterLink = await svc.list(companyId, "pending", { unlinkedOnly: true });
    expect(afterLink).toEqual([]);

    // The approval itself is untouched by linking — still visible on the unfiltered
    // /approvals/pending queue (the Dashboard tile), just no longer double-represented
    // as an orphan on top of its issue-linked representation.
    const unfiltered = await svc.list(companyId, "pending");
    expect(unfiltered.map((a) => a.id)).toEqual([approvalId]);
  });
});
