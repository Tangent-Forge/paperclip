import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ORIGIN_KIND_EMAIL } from "../src/constants.js";
import {
  extractEmailMessages,
  importEmailMessage,
  isCandidateEmail,
  readConfig,
  runEmailIntake,
  verifyWebhookSignature,
  type CouncilEmailMessage,
  type IntakeHost,
} from "../src/council-email-intake.js";

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

function email(overrides: Partial<CouncilEmailMessage> = {}): CouncilEmailMessage {
  return {
    sourceMessageId: "gmail-1",
    sourceThreadId: "thread-1",
    from: "Council Lead <lead@example.gov>",
    to: ["council@tangentforge.local"],
    cc: [],
    subject: "New routing request",
    textBody: "Please route this request.",
    htmlBody: null,
    receivedAt: "2026-06-08T12:00:00.000Z",
    labels: ["INBOX"],
    url: "https://mail.google.com/mail/u/0/#inbox/gmail-1",
    raw: {},
    ...overrides,
  };
}

function fakeHost() {
  const issues: IssueRecord[] = [];
  const links = new Map<string, any>();
  const state = new Map<string, unknown>();
  const runs: any[] = [];
  const host: IntakeHost = {
    db: {
      namespace: "plugin_council_email_intake_861efcc900",
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("INSERT INTO") && sql.includes("email_links")) {
          const [id, companyId, sourceMessageId, sourceThreadId, subject, sender, receivedAt, metadata] = params as string[];
          const key = `${companyId}:${sourceMessageId}`;
          const row = links.get(key) ?? {
            id,
            company_id: companyId,
            source_message_id: sourceMessageId,
            paperclip_issue_id: null,
            status: "reserved",
          };
          row.source_thread_id = sourceThreadId;
          row.subject = subject;
          row.sender = sender;
          row.received_at = receivedAt;
          row.metadata = metadata ? JSON.parse(metadata) : {};
          links.set(key, row);
          return [row] as any;
        }
        if (sql.includes("FROM") && sql.includes("intake_runs")) return runs as any;
        if (sql.includes("GROUP BY status")) return [{ status: "linked", count: String([...links.values()].filter((row) => row.status === "linked").length) }] as any;
        return [] as any;
      },
      async execute(sql: string, params: unknown[] = []) {
        if (sql.includes("UPDATE") && sql.includes("email_links")) {
          const [paperclipIssueId, sourceThreadId, subject, sender, receivedAt, linkId, companyId] = params as string[];
          const row = [...links.values()].find((candidate) => candidate.id === linkId && candidate.company_id === companyId);
          if (row) {
            row.paperclip_issue_id = paperclipIssueId;
            row.source_thread_id = sourceThreadId;
            row.subject = subject;
            row.sender = sender;
            row.received_at = receivedAt;
            row.status = "linked";
          }
          return { rowCount: 1 };
        }
        if (sql.includes("INSERT INTO") && sql.includes("intake_runs")) {
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

describe("council email intake", () => {
  it("normalizes config defaults and bounds", () => {
    expect(readConfig({}).defaultPriority).toBe("medium");
    expect(readConfig({ maxMessagesPerWebhook: 1000 }).maxMessagesPerWebhook).toBe(100);
    expect(readConfig({ allowedSenderDomains: [" Example.Gov "] }).allowedSenderDomains).toEqual(["example.gov"]);
  });

  it("verifies HMAC webhook signatures", () => {
    const body = JSON.stringify({ message: { id: "gmail-1" } });
    const signature = createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyWebhookSignature({ rawBody: body, headers: { "x-gmail-relay-signature": `sha256=${signature}` }, secret: "secret" })).toBe(true);
    expect(verifyWebhookSignature({ rawBody: body, headers: { "x-gmail-relay-signature": signature }, secret: "wrong" })).toBe(false);
  });

  it("extracts direct and pubsub-wrapped email payloads", () => {
    expect(extractEmailMessages({ message: { id: "gmail-1", subject: "Hello", to: "council@example.com" } })).toHaveLength(1);
    const wrapped = { message: { data: Buffer.from(JSON.stringify({ messages: [{ messageId: "gmail-2", headers: { Subject: "Wrapped" } }] })).toString("base64") } };
    expect(extractEmailMessages(wrapped)[0]).toMatchObject({ sourceMessageId: "gmail-2", subject: "Wrapped" });
  });

  it("filters sender domain, recipient, and subject candidates", () => {
    const config = readConfig({
      allowedSenderDomains: ["example.gov"],
      allowedRecipientPatterns: ["council@"],
      subjectIncludePatterns: ["routing"],
    });
    expect(isCandidateEmail(email(), config)).toBe(true);
    expect(isCandidateEmail(email({ from: "person@example.com" }), config)).toBe(false);
    expect(isCandidateEmail(email({ to: ["ops@tangentforge.local"] }), config)).toBe(false);
    expect(isCandidateEmail(email({ subject: "FYI" }), config)).toBe(false);
  });

  it("imports an email once and dedupes by source message id", async () => {
    const { host, issues } = fakeHost();
    const config = readConfig({ enabled: true, triageAgentId: "agent-1" });

    await runEmailIntake({ host, companyId: "company-1", config, messages: [email()], triggerKind: "manual" });
    await runEmailIntake({ host, companyId: "company-1", config, messages: [email()], triggerKind: "manual" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ originKind: ORIGIN_KIND_EMAIL, originId: "gmail-1", status: "todo" });
    expect(host.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("skips non-candidates and disabled runs without creating issues", async () => {
    const { host, issues } = fakeHost();
    const disabled = await runEmailIntake({ host, companyId: "company-1", config: readConfig({ enabled: false }), messages: [email()], triggerKind: "webhook" });
    const filtered = await importEmailMessage({ host, companyId: "company-1", config: readConfig({ enabled: true, allowedRecipientPatterns: ["board@"] }), message: email() });

    expect(disabled).toMatchObject({ status: "skipped", disabled: true });
    expect(filtered).toBe("not_candidate");
    expect(issues).toHaveLength(0);
  });
});
