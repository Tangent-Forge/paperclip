import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CompanionAuthorizationError,
  CompanionNotFoundError,
  createThread,
  decideProposal,
  findOrCreateCompanionIssue,
  gatherEvidence,
  getDeploymentHealthEvidence,
  getGithubEvidence,
  getLocalArtifactEvidence,
  getThreadWithMessages,
  listThreads,
  proposeAction,
  sendMessage,
} from "../src/companion-service.js";
import type {
  CompanionActionProposalRow,
  CompanionHost,
  CompanionInteractionResult,
  CompanionMessageRow,
  CompanionThreadRow,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// In-memory fake host — mirrors paperclip-plugin-linear-sync's fakeHost()
// pattern so this suite proves the plugin's own logic without a live
// database, live Anthropic API, or live GitHub API.
// ---------------------------------------------------------------------------

interface FakeState {
  threads: CompanionThreadRow[];
  messages: CompanionMessageRow[];
  proposals: CompanionActionProposalRow[];
  issues: Array<{ id: string; company_id: string; title: string; status: string }>;
  interactions: Array<{ id: string; issueId: string; companyId: string; status: string }>;
  activity: Array<{ companyId: string; message: string; entityType?: string; entityId?: string }>;
  config: Record<string, Record<string, unknown>>;
  httpResponses: Array<{ status: number; body: string }>;
  secrets: Record<string, string>;
  /** company_id -> companion_issue_id, mirrors companion_company_state's PK-uniqueness. */
  companyState: Record<string, string>;
}

function fakeHost(companyId: string, overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    threads: [],
    messages: [],
    proposals: [],
    issues: [],
    interactions: [],
    activity: [],
    config: { [companyId]: {} },
    httpResponses: [],
    secrets: {},
    companyState: {},
    ...overrides,
  };

  const host: CompanionHost = {
    db: {
      // Fixed fake namespace, standing in for the real host-derived schema
      // name (e.g. "plugin_companion_46345b9b3b"). companion-service.ts
      // always qualifies its own table references via table(host, name) —
      // this dispatcher matches on the bare table name as a substring of the
      // qualified reference, so it doesn't need to know the exact literal
      // namespace string, only that every reference contains it.
      namespace: "companion_test_ns",

      // Real ctx.db.query() is SELECT-only; real ctx.db.execute() is
      // INSERT/UPDATE/DELETE-only and returns no rows (see
      // PluginDatabaseClient in packages/plugins/sdk/src/types.ts). This
      // fake enforces the same split so a regression back to an
      // INSERT/UPDATE-via-query() (unusable against the real host) fails
      // loudly here instead of only in a live e2e run.
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        const normalized = sql.trim().toUpperCase();
        if (!normalized.startsWith("SELECT")) {
          throw new Error(`fakeHost.db.query: only SELECT is allowed (real ctx.db.query is SELECT-only): ${sql}`);
        }
        if (sql.includes("companion_company_state")) {
          const [cid] = params as string[];
          const issueId = state.companyState[cid];
          return (issueId ? [{ companion_issue_id: issueId }] : []) as unknown as T[];
        }
        if (sql.includes("companion_threads") && sql.includes("AND id = $2")) {
          const [cid, id] = params as string[];
          return state.threads.filter((t) => t.company_id === cid && t.id === id) as unknown as T[];
        }
        if (sql.includes("companion_threads")) {
          const [cid] = params as string[];
          return state.threads
            .filter((t) => t.company_id === cid)
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at)) as unknown as T[];
        }
        if (sql.includes("companion_messages") && sql.includes("client_request_id = $3")) {
          const [tid, role, crid] = params as string[];
          return state.messages.filter((m) => m.thread_id === tid && m.role === role && m.client_request_id === crid) as unknown as T[];
        }
        if (sql.includes("companion_messages") && sql.includes("WHERE id = $1")) {
          const [id] = params as string[];
          return state.messages.filter((m) => m.id === id) as unknown as T[];
        }
        if (sql.includes("companion_messages")) {
          const [cid, tid] = params as string[];
          return state.messages
            .filter((m) => m.company_id === cid && m.thread_id === tid)
            .sort((a, b) => a.created_at.localeCompare(b.created_at)) as unknown as T[];
        }
        if (sql.includes("companion_action_proposals") && sql.includes("AND message_id = $2")) {
          const [cid, mid] = params as string[];
          return state.proposals.filter((p) => p.company_id === cid && p.message_id === mid) as unknown as T[];
        }
        if (sql.includes("companion_action_proposals") && sql.includes("AND thread_id = $2")) {
          const [cid, tid] = params as string[];
          return state.proposals
            .filter((p) => p.company_id === cid && p.thread_id === tid)
            .sort((a, b) => a.created_at.localeCompare(b.created_at)) as unknown as T[];
        }
        if (sql.includes("companion_action_proposals") && sql.includes("AND id = $2")) {
          const [cid, id] = params as string[];
          return state.proposals.filter((p) => p.company_id === cid && p.id === id) as unknown as T[];
        }
        throw new Error(`fakeHost.db.query: unhandled SQL: ${sql}`);
      },
      async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
        const normalized = sql.trim().toUpperCase();
        if (normalized.startsWith("SELECT")) {
          throw new Error(`fakeHost.db.execute: SELECT is not allowed (use query()): ${sql}`);
        }
        if (sql.startsWith("INSERT INTO") && sql.includes("companion_company_state")) {
          const [cid, issueId] = params as string[];
          if (state.companyState[cid]) return { rowCount: 0 }; // ON CONFLICT (company_id) DO NOTHING
          state.companyState[cid] = issueId;
          return { rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO") && sql.includes("companion_threads")) {
          const [id, company_id, title, created_by_user_id] = params as string[];
          const row: CompanionThreadRow = {
            id,
            company_id,
            title,
            created_by_user_id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          state.threads.push(row);
          return { rowCount: 1 };
        }
        if (sql.startsWith("UPDATE") && sql.includes("companion_threads")) {
          const [cid, id] = params as string[];
          const t = state.threads.find((th) => th.company_id === cid && th.id === id);
          if (t) t.updated_at = new Date().toISOString();
          return { rowCount: t ? 1 : 0 };
        }
        if (sql.startsWith("INSERT INTO") && sql.includes("companion_messages")) {
          const [id, company_id, thread_id, role, actor_user_id, body, evidence, client_request_id = null] = params as [
            string,
            string,
            string,
            "human" | "companion",
            string | null,
            string,
            string | null,
            string | null | undefined,
          ];
          if (client_request_id) {
            const dup = state.messages.find(
              (m) => m.thread_id === thread_id && m.role === role && m.client_request_id === client_request_id,
            );
            if (dup) return { rowCount: 0 }; // ON CONFLICT (thread_id, role, client_request_id) DO NOTHING
          }
          const row: CompanionMessageRow = {
            id,
            company_id,
            thread_id,
            role,
            actor_user_id,
            body,
            evidence: evidence ? JSON.parse(evidence) : null,
            client_request_id: client_request_id ?? null,
            created_at: new Date().toISOString(),
          };
          state.messages.push(row);
          return { rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO") && sql.includes("companion_action_proposals")) {
          const [id, company_id, thread_id, message_id, companion_issue_id, interaction_id, summary] = params as string[];
          const dup = state.proposals.find((p) => p.company_id === company_id && p.message_id === message_id);
          if (dup) return { rowCount: 0 }; // ON CONFLICT (company_id, message_id) DO NOTHING
          const row: CompanionActionProposalRow = {
            id,
            company_id,
            thread_id,
            message_id,
            companion_issue_id,
            interaction_id,
            summary,
            status: "pending",
            decided_by_user_id: null,
            decided_at: null,
            created_at: new Date().toISOString(),
          };
          state.proposals.push(row);
          return { rowCount: 1 };
        }
        if (sql.startsWith("UPDATE") && sql.includes("companion_action_proposals")) {
          const [status, decidedByUserId, cid, id] = params as string[];
          const proposal = state.proposals.find((p) => p.company_id === cid && p.id === id && p.status === "pending");
          if (!proposal) return { rowCount: 0 };
          proposal.status = status as "accepted" | "rejected";
          proposal.decided_by_user_id = decidedByUserId;
          proposal.decided_at = new Date().toISOString();
          return { rowCount: 1 };
        }
        throw new Error(`fakeHost.db.execute: unhandled SQL: ${sql}`);
      },
    },
    issues: {
      async list(input) {
        return state.issues
          .filter((i) => i.company_id === input.companyId && (!input.q || i.title === input.q))
          .map((i) => ({ id: i.id, title: i.title, status: i.status }));
      },
      async create(input) {
        const row = { id: randomUUID(), company_id: input.companyId, title: input.title, status: "todo" };
        state.issues.push(row);
        return { id: row.id, title: row.title, status: row.status };
      },
      async requestConfirmation(issueId, _interaction, companyId): Promise<CompanionInteractionResult> {
        const id = randomUUID();
        state.interactions.push({ id, issueId, companyId, status: "pending" });
        return { id };
      },
      async respondInteraction(_issueId, interactionId, input, companyId) {
        if (!input.actorUserId) {
          // Mirrors the real host's own re-verification failure mode.
          throw new Error("actorUserId is required to resolve an interaction");
        }
        const interaction = state.interactions.find((i) => i.id === interactionId && i.companyId === companyId);
        if (!interaction) throw new Error("interaction not found");
        if (interaction.status !== "pending") {
          return { interaction: { id: interaction.id, status: interaction.status }, applied: false };
        }
        interaction.status = input.action === "accept" ? "accepted" : "rejected";
        return { interaction: { id: interaction.id, status: interaction.status }, applied: true };
      },
    },
    agents: {
      async list() {
        return [];
      },
    },
    activity: {
      async log(entry) {
        state.activity.push(entry);
      },
    },
    secrets: {
      async resolve(ref, opts) {
        // Mirrors the real host: a raw string secretRef is rejected outright
        // (see config-validation.ts's parseSecretRefBinding comment) — only
        // the { type: "secret_ref", secretId, version? } binding object
        // resolves, keyed by secretId.
        if (typeof ref === "string") {
          throw new Error(`fakeHost.secrets.resolve: raw string secretRef is rejected (got "${ref}")`);
        }
        return state.secrets[`${opts.companyId}:${ref.secretId}`] ?? null;
      },
    },
    http: {
      async fetch() {
        const next = state.httpResponses.shift();
        if (!next) throw new Error("no fake http response queued");
        return {
          status: next.status,
          ok: next.status >= 200 && next.status < 300,
          async text() {
            return next.body;
          },
        };
      },
    },
    localFolders: {
      async status() {
        return { configured: false, healthy: false };
      },
      async readText() {
        throw new Error("not configured");
      },
      async list() {
        return [];
      },
    },
    config: {
      async get(cid) {
        return state.config[cid ?? companyId] ?? {};
      },
    },
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  };

  return { host, state };
}

/**
 * Test-only helper for seeding a human message directly (bypassing
 * sendMessage()'s evidence-gathering/LLM-call machinery) in tests that only
 * need a message row to exist so proposeAction()/decideProposal() have
 * something to attach to. Mirrors real ctx.db usage: execute() to insert
 * (no RETURNING — the real host doesn't support it), then query() to read
 * the row back. Returns a 1-element array to match host.db.query()'s
 * shape, since call sites index it as `humanMsg[0]`.
 */
async function insertTestHumanMessage(
  host: CompanionHost,
  companyId: string,
  threadId: string,
  actorUserId: string,
  body: string,
): Promise<CompanionMessageRow[]> {
  const id = randomUUID();
  await host.db.execute(
    `INSERT INTO companion_messages (id, company_id, thread_id, role, actor_user_id, body, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, companyId, threadId, "human", actorUserId, body, null],
  );
  return host.db.query<CompanionMessageRow>(`SELECT * FROM companion_messages WHERE id = $1`, [id]);
}

describe("companion-service — thread/message persistence", () => {
  it("creates a thread scoped to the requesting company and human actor", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    const thread = await createThread(host, companyId, "user-1", "My conversation");
    expect(thread.company_id).toBe(companyId);
    expect(thread.created_by_user_id).toBe("user-1");
  });

  it("rejects thread creation without an authenticated human actor", async () => {
    const { host } = fakeHost("company-a");
    await expect(createThread(host, "company-a", "", "title")).rejects.toThrow(CompanionAuthorizationError);
  });

  it("throws CompanionNotFoundError for a thread id that does not exist in the given company", async () => {
    const { host } = fakeHost("company-a");
    await expect(getThreadWithMessages(host, "company-a", randomUUID())).rejects.toThrow(CompanionNotFoundError);
  });
});

describe("companion-service — company isolation", () => {
  it("never returns another company's threads from listThreads", async () => {
    const { host, state } = fakeHost("company-a");
    await createThread(host, "company-a", "user-1", "A's thread");
    state.threads.push({
      id: randomUUID(),
      company_id: "company-b",
      title: "B's thread",
      created_by_user_id: "user-2",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const listA = await listThreads(host, "company-a");
    const listB = await listThreads(host, "company-b");

    expect(listA.every((t) => t.company_id === "company-a")).toBe(true);
    expect(listB.every((t) => t.company_id === "company-b")).toBe(true);
    expect(listA.some((t) => t.title === "B's thread")).toBe(false);
  });

  it("does not resolve a thread by id across companies", async () => {
    const { host } = fakeHost("company-a");
    const thread = await createThread(host, "company-a", "user-1", "A's thread");
    await expect(getThreadWithMessages(host, "company-b", thread.id)).rejects.toThrow(CompanionNotFoundError);
  });
});

describe("companion-service — actor attribution", () => {
  it("stamps every human message with the real actorUserId and every companion message with none", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId, {
      httpResponses: [
        { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "The answer is 42." }] }) },
      ],
      secrets: { [`${companyId}:anthropic-key-ref`]: "sk-fake" },
      config: { [companyId]: { anthropicApiKeySecretRef: { type: "secret_ref", secretId: "anthropic-key-ref" } } },
    });
    const thread = await createThread(host, companyId, "user-1", "Q&A");
    await sendMessage(host, companyId, thread.id, "user-1", "What's the answer?");

    const human = state.messages.find((m) => m.role === "human")!;
    const companion = state.messages.find((m) => m.role === "companion")!;
    expect(human.actor_user_id).toBe("user-1");
    expect(companion.actor_user_id).toBeNull();
  });
});

describe("companion-service — direct-agent/session separation", () => {
  it("performs the full send-message flow using only db/issues/agents/http/secrets/localFolders/activity/config — never an agents-session client", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId, {
      // First response is consumed by the deployment-health evidence tool's
      // fetch (part of gatherEvidence), the second by the actual LLM call.
      httpResponses: [
        { status: 200, body: JSON.stringify({ status: "ok" }) },
        { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "ok" }] }) },
      ],
      secrets: { [`${companyId}:key`]: "sk-fake" },
      config: { [companyId]: { anthropicApiKeySecretRef: { type: "secret_ref", secretId: "key" }} },
    });
    // The fake host object above has no `agentSessions`/`agents.sessions` field
    // at all — companion-service.ts's CompanionHost type doesn't declare one.
    // This test proves end-to-end functionality is achievable without it.
    expect((host as unknown as { agentSessions?: unknown }).agentSessions).toBeUndefined();
    const thread = await createThread(host, companyId, "user-1", "t");
    const result = await sendMessage(host, companyId, thread.id, "user-1", "hi");
    expect(result.companionMessage.body).toContain("ok");
  });
});

describe("companion-service — no Companion self-approval", () => {
  it("rejects decideProposal when no authenticated human actorUserId is supplied", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    const thread = await createThread(host, companyId, "user-1", "t");
    const humanMsg = await insertTestHumanMessage(host, companyId, thread.id, "user-1", "hi");
    const proposal = await proposeAction(host, companyId, thread.id, humanMsg[0].id, "Do the thing");

    await expect(decideProposal(host, companyId, proposal.id, "accept", undefined)).rejects.toThrow(
      CompanionAuthorizationError,
    );
    await expect(decideProposal(host, companyId, proposal.id, "accept", "")).rejects.toThrow(CompanionAuthorizationError);
  });

  it("allows decideProposal to proceed only with a real human actorUserId, attributed to that human", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    const thread = await createThread(host, companyId, "user-1", "t");
    const humanMsg = await insertTestHumanMessage(host, companyId, thread.id, "user-1", "hi");
    const proposal = await proposeAction(host, companyId, thread.id, humanMsg[0].id, "Do the thing");

    const decided = await decideProposal(host, companyId, proposal.id, "accept", "user-1");
    expect(decided.status).toBe("accepted");
    expect(decided.decided_by_user_id).toBe("user-1");
  });
});

describe("companion-service — idempotency / duplicate resolution", () => {
  it("returns the already-decided proposal without re-invoking respondInteraction on a repeat decide call", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    const thread = await createThread(host, companyId, "user-1", "t");
    const humanMsg = await insertTestHumanMessage(host, companyId, thread.id, "user-1", "hi");
    const proposal = await proposeAction(host, companyId, thread.id, humanMsg[0].id, "Do the thing");

    const respondSpy = vi.spyOn(host.issues, "respondInteraction");
    const first = await decideProposal(host, companyId, proposal.id, "accept", "user-1");
    const second = await decideProposal(host, companyId, proposal.id, "reject", "user-2");

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted"); // unchanged by the second (already-decided) call
    expect(second.decided_by_user_id).toBe("user-1"); // not overwritten by user-2's later call
    expect(respondSpy).toHaveBeenCalledTimes(1);
  });
});

describe("companion-service — evidence tool failure paths", () => {
  it("reports a redacted, non-leaking failure when the health endpoint is unreachable", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    host.http.fetch = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:9999 secret-looking-detail=abc123");
    };
    const evidence = await getDeploymentHealthEvidence(host, companyId);
    expect(evidence.success).toBe(false);
    expect(evidence.redactedError).not.toContain("secret-looking-detail");
    expect(evidence.redactedError).not.toContain("9999");
  });

  it("reports missing runtime distinctly (non-2xx) rather than crashing", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId);
    state.httpResponses.push({ status: 503, body: "" });
    const evidence = await getDeploymentHealthEvidence(host, companyId);
    expect(evidence.success).toBe(false);
    expect(evidence.summary).toContain("503");
  });

  it("reports missing repository distinctly when health responds but has no git identity", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId);
    state.httpResponses.push({ status: 200, body: JSON.stringify({ status: "ok" }) });
    const evidence = await getDeploymentHealthEvidence(host, companyId);
    expect(evidence.success).toBe(true);
    expect(evidence.summary).toContain("no git identity");
  });

  it("never fabricates PR/CI status when GitHub is not configured", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    const evidence = await getGithubEvidence(host, companyId);
    expect(evidence.success).toBe(false);
    expect(evidence.redactedError).toBe("not_configured");
  });

  it("gatherEvidence collects all four sources even when some fail", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId);
    state.httpResponses.push({ status: 200, body: JSON.stringify({ status: "ok" }) });
    const evidence = await gatherEvidence(host, companyId);
    expect(evidence).toHaveLength(4);
    expect(evidence.map((e) => e.source).sort()).toEqual(
      ["agents", "deployment_health", "github", "local_artifact"].sort(),
    );
  });
});

describe("companion-service — standing issue reuse (find-or-create)", () => {
  it("creates the standing issue once and reuses it on subsequent calls", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId);
    const first = await findOrCreateCompanionIssue(host, companyId);
    const second = await findOrCreateCompanionIssue(host, companyId);
    expect(first).toBe(second);
    expect(state.issues.filter((i) => i.company_id === companyId).length).toBe(1);
  });

  it("resolves concurrent first-time calls to a single issue, not one each (race safety)", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    // Ten concurrent callers, none of whom have seen a winner yet.
    const results = await Promise.all(Array.from({ length: 10 }, () => findOrCreateCompanionIssue(host, companyId)));
    const distinctIds = new Set(results);
    // Every caller must agree on exactly one issue id, even though several of
    // them may have each created their own candidate issue along the way
    // (companion_company_state.company_id's PK uniqueness is the single
    // atomic decision point — see findOrCreateCompanionIssue).
    expect(distinctIds.size).toBe(1);
  });
});

describe("companion-service — proposal hydration (persisted-proposal-visibility-after-reload)", () => {
  it("returns proposals alongside thread/messages so a reload can restore proposal state from storage", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    const thread = await createThread(host, companyId, "user-1", "t");
    const humanMsg = await insertTestHumanMessage(host, companyId, thread.id, "user-1", "hi");
    const proposal = await proposeAction(host, companyId, thread.id, humanMsg[0].id, "Do the thing");
    await decideProposal(host, companyId, proposal.id, "accept", "user-1");

    // Simulate a fresh page load: nothing but the persisted DB state is
    // consulted here — no in-memory React state survives a reload.
    const reloaded = await getThreadWithMessages(host, companyId, thread.id);
    expect(reloaded.proposals).toHaveLength(1);
    expect(reloaded.proposals[0].id).toBe(proposal.id);
    expect(reloaded.proposals[0].status).toBe("accepted");
    expect(reloaded.proposals[0].decided_by_user_id).toBe("user-1");
  });

  it("never returns another company's proposals from a reload", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    const thread = await createThread(host, companyId, "user-1", "t");
    const humanMsg = await insertTestHumanMessage(host, companyId, thread.id, "user-1", "hi");
    await proposeAction(host, companyId, thread.id, humanMsg[0].id, "Do the thing");

    await expect(getThreadWithMessages(host, "company-b", thread.id)).rejects.toThrow(CompanionNotFoundError);
  });
});

describe("companion-service — idempotency (durable keys, not just in-memory UI state)", () => {
  it("sendMessage with a repeated clientRequestId returns the same persisted pair instead of creating duplicates", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId, {
      httpResponses: [
        { status: 200, body: JSON.stringify({ status: "ok" }) },
        { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "answer" }] }) },
      ],
      secrets: { [`${companyId}:key`]: "sk-fake" },
      config: { [companyId]: { anthropicApiKeySecretRef: { type: "secret_ref", secretId: "key" }} },
    });
    const thread = await createThread(host, companyId, "user-1", "t");
    const clientRequestId = randomUUID();

    const first = await sendMessage(host, companyId, thread.id, "user-1", "hello", clientRequestId);
    // A retry with the same key must not call the LLM again — no further
    // http responses are queued, so a second real call would throw.
    const second = await sendMessage(host, companyId, thread.id, "user-1", "hello", clientRequestId);

    expect(second.humanMessage.id).toBe(first.humanMessage.id);
    expect(second.companionMessage.id).toBe(first.companionMessage.id);
    expect(state.messages.filter((m) => m.thread_id === thread.id)).toHaveLength(2);
  });

  it("a different clientRequestId in the same thread creates a distinct pair", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId, {
      httpResponses: [
        { status: 200, body: JSON.stringify({ status: "ok" }) },
        { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "a1" }] }) },
        { status: 200, body: JSON.stringify({ status: "ok" }) },
        { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "a2" }] }) },
      ],
      secrets: { [`${companyId}:key`]: "sk-fake" },
      config: { [companyId]: { anthropicApiKeySecretRef: { type: "secret_ref", secretId: "key" }} },
    });
    const thread = await createThread(host, companyId, "user-1", "t");
    await sendMessage(host, companyId, thread.id, "user-1", "hello", randomUUID());
    await sendMessage(host, companyId, thread.id, "user-1", "hello again", randomUUID());
    expect(state.messages.filter((m) => m.thread_id === thread.id)).toHaveLength(4);
  });

  it("proposeAction with a duplicate call for the same message returns the existing proposal, not a second one", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId);
    const thread = await createThread(host, companyId, "user-1", "t");
    const humanMsg = await insertTestHumanMessage(host, companyId, thread.id, "user-1", "hi");
    const first = await proposeAction(host, companyId, thread.id, humanMsg[0].id, "Do the thing");
    const second = await proposeAction(host, companyId, thread.id, humanMsg[0].id, "Do a different thing");

    expect(second.id).toBe(first.id);
    expect(second.summary).toBe("Do the thing"); // the first proposal's summary wins, not the duplicate call's
    expect(state.proposals.filter((p) => p.message_id === humanMsg[0].id)).toHaveLength(1);
  });

  it("concurrent duplicate proposeAction calls for the same message resolve to one persisted proposal (race safety)", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId);
    const thread = await createThread(host, companyId, "user-1", "t");
    const humanMsg = await insertTestHumanMessage(host, companyId, thread.id, "user-1", "hi");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => proposeAction(host, companyId, thread.id, humanMsg[0].id, "Do the thing")),
    );
    const distinctIds = new Set(results.map((r) => r.id));
    expect(distinctIds.size).toBe(1);
    expect(state.proposals.filter((p) => p.message_id === humanMsg[0].id)).toHaveLength(1);
  });
});

describe("companion-service — outbound config hardening", () => {
  it("refuses a malformed githubRepo instead of using it in an outbound request", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId, {
      secrets: { [`${companyId}:tok`]: "gh-fake" },
      config: { [companyId]: { githubRepo: "not-a-valid-repo-string", githubTokenSecretRef: { type: "secret_ref", secretId: "tok" } } },
    });
    // No http response is queued — if getGithubEvidence attempted the fetch
    // anyway, the fake host.http.fetch would throw "no fake http response
    // queued" and this test would fail with that error instead of asserting
    // the expected refusal.
    const evidence = await getGithubEvidence(host, companyId);
    expect(evidence.success).toBe(false);
    expect(evidence.redactedError).toBe("invalid_repo_format");
  });

  it("refuses a non-loopback, non-allowlisted healthCheckUrl instead of fetching it", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId, {
      config: { [companyId]: { healthCheckUrl: "http://169.254.169.254/latest/meta-data/" } },
    });
    const evidence = await getDeploymentHealthEvidence(host, companyId);
    expect(evidence.success).toBe(false);
    expect(evidence.redactedError).toBe("invalid_or_disallowed_url");
  });

  it("allows a non-loopback healthCheckUrl once explicitly allowlisted", async () => {
    const companyId = "company-a";
    const { host, state } = fakeHost(companyId, {
      config: {
        [companyId]: {
          healthCheckUrl: "https://staging.internal.example.com/api/health",
          healthCheckHostAllowlist: ["staging.internal.example.com"],
        },
      },
    });
    state.httpResponses.push({ status: 200, body: JSON.stringify({ status: "ok" }) });
    const evidence = await getDeploymentHealthEvidence(host, companyId);
    expect(evidence.success).toBe(true);
  });
});

describe("companion-service — Anthropic provider contract (secret hygiene)", () => {
  // Direct Anthropic call is a deliberate MVP choice, not an oversight: see
  // doc/plans/2026-08-25-paperclip-companion-design.md §1. Independently
  // reverified here (not just asserted in the design doc): ctx.agents.sessions
  // (packages/plugins/sdk/src/types.ts PluginAgentSessionsClient.create) takes
  // a required `agentId` naming a real, existing organizational agent — there
  // is no Paperclip-provided model/runtime service that can make this call
  // without either impersonating or creating an organizational agent, which
  // this feature must not do. These tests cover the resulting secret-hygiene
  // contract for the direct call.
  const companyId = "company-a";
  const SECRET_MARKER = "sk-super-secret-marker-should-never-leak-ANYWHERE";

  it("never persists, logs, or throws the resolved API key even when the provider call fails", async () => {
    const { host, state } = fakeHost(companyId, {
      secrets: { [`${companyId}:key`]: SECRET_MARKER },
      config: { [companyId]: { anthropicApiKeySecretRef: { type: "secret_ref", secretId: "key" }} },
    });
    host.http.fetch = async (url) => {
      if (typeof url === "string" && url.includes("anthropic.com")) {
        throw new Error(`network failure while using key ${SECRET_MARKER}`);
      }
      return { status: 200, ok: true, async text() { return JSON.stringify({ status: "ok" }); } };
    };
    const thread = await createThread(host, companyId, "user-1", "t");
    const result = await sendMessage(host, companyId, thread.id, "user-1", "hello");

    const serialized = JSON.stringify({ messages: state.messages, activity: state.activity, result });
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(result.companionMessage.body).not.toContain(SECRET_MARKER);
  });

  it("never lets a throwing secrets.resolve() propagate uncaught out of sendMessage — persists a reply instead of an interrupted state", async () => {
    // Reproduces the real host's actual failure mode found during disposable
    // e2e validation: host.secrets.resolve() throws (e.g. binding_missing,
    // binding_ambiguous, rate limit) rather than returning null. Before this
    // fix, that throw propagated straight out of sendMessage() with no
    // persisted companion reply — surfacing in the UI as the interrupted
    // state instead of the deterministic "couldn't complete that request"
    // reply this path is supposed to produce.
    const { host, state } = fakeHost(companyId, {
      httpResponses: [{ status: 200, body: JSON.stringify({ status: "ok" }) }],
      config: { [companyId]: { anthropicApiKeySecretRef: { type: "secret_ref", secretId: "key" } } },
    });
    host.secrets.resolve = async () => {
      throw new Error("Secret is not bound to plugin:paperclipai.companion");
    };
    const thread = await createThread(host, companyId, "user-1", "t");
    const result = await sendMessage(host, companyId, thread.id, "user-1", "hello");
    expect(result.companionMessage.body).toContain("couldn't complete that request");
    expect(state.messages.filter((m) => m.thread_id === thread.id)).toHaveLength(2);
  });

  it("reports a generic, non-leaking error to the human when the provider returns a non-2xx status", async () => {
    const { host } = fakeHost(companyId, {
      httpResponses: [
        { status: 200, body: JSON.stringify({ status: "ok" }) },
        { status: 401, body: JSON.stringify({ error: { message: `invalid key ${SECRET_MARKER}` } }) },
      ],
      secrets: { [`${companyId}:key`]: SECRET_MARKER },
      config: { [companyId]: { anthropicApiKeySecretRef: { type: "secret_ref", secretId: "key" }} },
    });
    const thread = await createThread(host, companyId, "user-1", "t");
    const result = await sendMessage(host, companyId, thread.id, "user-1", "hello");
    expect(result.companionMessage.body).toContain("HTTP 401");
    expect(result.companionMessage.body).not.toContain(SECRET_MARKER);
  });
});

describe("companion-service — repo-aware evidence: reading a specific allowlisted file", () => {
  it("reads a file that is present in the directory listing", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    host.localFolders.status = async () => ({ configured: true, healthy: true });
    host.localFolders.list = async () => [{ path: "cutover-receipt.md", isDirectory: false }];
    host.localFolders.readText = async (_cid, _key, path) => {
      expect(path).toBe("cutover-receipt.md");
      return "Cutover completed at 2026-08-25T00:00:00Z.";
    };
    const evidence = await getLocalArtifactEvidence(host, companyId, "cutover-receipt.md");
    expect(evidence.success).toBe(true);
    expect(evidence.summary).toContain("Cutover completed");
    expect(evidence.identity?.path).toBe("cutover-receipt.md");
  });

  it("refuses a requested file that is not in the directory listing, without calling readText", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    host.localFolders.status = async () => ({ configured: true, healthy: true });
    host.localFolders.list = async () => [{ path: "other.md", isDirectory: false }];
    host.localFolders.readText = async () => {
      throw new Error("readText must not be called for an unlisted file");
    };
    const evidence = await getLocalArtifactEvidence(host, companyId, "secrets.env");
    expect(evidence.success).toBe(false);
    expect(evidence.redactedError).toBe("file_not_found");
  });

  it("reports a file count summary (no readText call) when no specific file is requested", async () => {
    const companyId = "company-a";
    const { host } = fakeHost(companyId);
    host.localFolders.status = async () => ({ configured: true, healthy: true });
    host.localFolders.list = async () => [
      { path: "a.md", isDirectory: false },
      { path: "b.md", isDirectory: false },
    ];
    host.localFolders.readText = async () => {
      throw new Error("readText must not be called when no file was requested");
    };
    const evidence = await getLocalArtifactEvidence(host, companyId, null);
    expect(evidence.success).toBe(true);
    expect(evidence.summary).toContain("2 file(s)");
  });
});
