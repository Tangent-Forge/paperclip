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
    ...overrides,
  };

  const host: CompanionHost = {
    db: {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        if (sql.startsWith("INSERT INTO companion_threads")) {
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
          return [row] as unknown as T[];
        }
        if (sql.startsWith("SELECT * FROM companion_threads WHERE company_id = $1 AND id = $2")) {
          const [cid, id] = params as string[];
          return state.threads.filter((t) => t.company_id === cid && t.id === id) as unknown as T[];
        }
        if (sql.startsWith("SELECT * FROM companion_threads")) {
          const [cid] = params as string[];
          return state.threads
            .filter((t) => t.company_id === cid)
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at)) as unknown as T[];
        }
        if (sql.startsWith("INSERT INTO companion_messages")) {
          const [id, company_id, thread_id, role, actor_user_id, body, evidence] = params as [
            string,
            string,
            string,
            "human" | "companion",
            string | null,
            string,
            string | null,
          ];
          const row: CompanionMessageRow = {
            id,
            company_id,
            thread_id,
            role,
            actor_user_id,
            body,
            evidence: evidence ? JSON.parse(evidence) : null,
            created_at: new Date().toISOString(),
          };
          state.messages.push(row);
          return [row] as unknown as T[];
        }
        if (sql.startsWith("SELECT * FROM companion_messages")) {
          const [cid, tid] = params as string[];
          return state.messages
            .filter((m) => m.company_id === cid && m.thread_id === tid)
            .sort((a, b) => a.created_at.localeCompare(b.created_at)) as unknown as T[];
        }
        if (sql.startsWith("INSERT INTO companion_action_proposals")) {
          const [id, company_id, thread_id, message_id, companion_issue_id, interaction_id, summary] = params as string[];
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
          return [row] as unknown as T[];
        }
        if (sql.startsWith("SELECT * FROM companion_action_proposals")) {
          const [cid, id] = params as string[];
          return state.proposals.filter((p) => p.company_id === cid && p.id === id) as unknown as T[];
        }
        if (sql.startsWith("UPDATE companion_action_proposals")) {
          const [status, decidedByUserId, cid, id] = params as string[];
          const proposal = state.proposals.find((p) => p.company_id === cid && p.id === id && p.status === "pending");
          if (!proposal) return [] as unknown as T[];
          proposal.status = status as "accepted" | "rejected";
          proposal.decided_by_user_id = decidedByUserId;
          proposal.decided_at = new Date().toISOString();
          return [proposal] as unknown as T[];
        }
        throw new Error(`fakeHost.db.query: unhandled SQL: ${sql}`);
      },
      async execute() {
        return { rowCount: 1 };
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
        return state.secrets[`${opts.companyId}:${ref}`] ?? null;
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
      config: { [companyId]: { anthropicApiKeySecretRef: "anthropic-key-ref" } },
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
      config: { [companyId]: { anthropicApiKeySecretRef: "key" } },
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
    const humanMsg = await host.db.query<CompanionMessageRow>(
      `INSERT INTO companion_messages (id, company_id, thread_id, role, actor_user_id, body, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), companyId, thread.id, "human", "user-1", "hi", null],
    );
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
    const humanMsg = await host.db.query<CompanionMessageRow>(
      `INSERT INTO companion_messages (id, company_id, thread_id, role, actor_user_id, body, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), companyId, thread.id, "human", "user-1", "hi", null],
    );
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
    const humanMsg = await host.db.query<CompanionMessageRow>(
      `INSERT INTO companion_messages (id, company_id, thread_id, role, actor_user_id, body, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), companyId, thread.id, "human", "user-1", "hi", null],
    );
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
});
