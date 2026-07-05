import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Issue } from "@paperclipai/plugin-sdk";
import { ORIGIN_KIND_EMAIL, PLUGIN_ID } from "./constants.js";

export type CouncilEmailIntakeConfig = {
  enabled: boolean;
  companyId: string | null;
  projectId: string | null;
  triageAgentId: string | null;
  defaultPriority: "low" | "medium" | "high" | "critical";
  allowedSenderDomains: string[];
  allowedRecipientPatterns: string[];
  subjectIncludePatterns: string[];
  gmailWebhookSigningSecretRef: string | null;
  maxMessagesPerWebhook: number;
};

export type CouncilEmailMessage = {
  sourceMessageId: string;
  sourceThreadId: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: string | null;
  labels: string[];
  url: string | null;
  raw: Record<string, unknown>;
};

export type IntakeSummary = {
  triggerKind: "webhook" | "manual";
  status: "success" | "skipped" | "failed";
  startedAt: string;
  finishedAt: string;
  importedCount: number;
  skippedDuplicateCount: number;
  skippedNonCandidateCount: number;
  failedCount: number;
  failures: string[];
  disabled?: boolean;
};

type EmailLinkRow = {
  id: string;
  company_id: string;
  source_message_id: string;
  source_thread_id: string | null;
  paperclip_issue_id: string | null;
  status: string;
};

export type IntakeHost = {
  db: {
    namespace: string;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  };
  issues: {
    list(input: { companyId: string; originKind?: string; originId?: string; limit?: number; includePluginOperations?: boolean }): Promise<Issue[]>;
    create(input: {
      companyId: string;
      projectId?: string;
      title: string;
      description?: string;
      status?: Issue["status"];
      priority?: Issue["priority"];
      assigneeAgentId?: string;
      originKind?: string;
      originId?: string | null;
      actor?: { actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null };
    }): Promise<Issue>;
    requestWakeup(issueId: string, companyId: string, options?: { reason?: string; contextSource?: string; idempotencyKey?: string | null; actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null }): Promise<{ queued: boolean }>;
  };
  state: {
    get(input: { scopeKind: "company"; scopeId: string; namespace?: string; stateKey: string }): Promise<unknown>;
    set(input: { scopeKind: "company"; scopeId: string; namespace?: string; stateKey: string }, value: unknown): Promise<void>;
  };
  activity?: { log(entry: { companyId: string; message: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> }): Promise<void> };
  metrics?: { write(name: string, value: number, tags?: Record<string, string>): Promise<void> };
  telemetry?: { track(eventName: string, dimensions?: Record<string, string | number | boolean>): Promise<void> };
};

export function readConfig(raw: Record<string, unknown>): CouncilEmailIntakeConfig {
  const str = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  const int = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(parsed)));
  };
  const priority = str(raw.defaultPriority);
  return {
    enabled: raw.enabled === true,
    companyId: str(raw.companyId),
    projectId: str(raw.projectId),
    triageAgentId: str(raw.triageAgentId),
    defaultPriority: priority === "low" || priority === "medium" || priority === "high" || priority === "critical" ? priority : "medium",
    allowedSenderDomains: strings(raw.allowedSenderDomains).map((domain) => domain.toLowerCase()),
    allowedRecipientPatterns: strings(raw.allowedRecipientPatterns).length > 0 ? strings(raw.allowedRecipientPatterns) : ["council"],
    subjectIncludePatterns: strings(raw.subjectIncludePatterns),
    gmailWebhookSigningSecretRef: str(raw.gmailWebhookSigningSecretRef),
    maxMessagesPerWebhook: int(raw.maxMessagesPerWebhook, 25, 1, 100),
  };
}

export function verifyWebhookSignature(input: { rawBody: string; headers: Record<string, string | string[]>; secret: string }): boolean {
  const signature = headerValue(input.headers, "x-paperclip-signature")
    ?? headerValue(input.headers, "x-gmail-relay-signature")
    ?? headerValue(input.headers, "x-hub-signature-256");
  if (!signature) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const actual = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function extractEmailMessages(payload: unknown): CouncilEmailMessage[] {
  const expanded = expandPayload(payload);
  const candidates: unknown[] = Array.isArray(expanded)
    ? expanded
    : expanded && typeof expanded === "object" && Array.isArray((expanded as Record<string, unknown>).messages)
      ? (expanded as Record<string, unknown>).messages as unknown[]
      : expanded && typeof expanded === "object" && (expanded as Record<string, unknown>).message
        ? [(expanded as Record<string, unknown>).message]
        : expanded ? [expanded] : [];
  return candidates.map(normalizeMessage).filter((message): message is CouncilEmailMessage => message !== null);
}

export function isCandidateEmail(message: CouncilEmailMessage, config: CouncilEmailIntakeConfig): boolean {
  if (config.allowedSenderDomains.length > 0) {
    const senderDomain = message.from ? emailDomain(message.from) : null;
    if (!senderDomain || !config.allowedSenderDomains.some((domain) => senderDomain === domain || senderDomain.endsWith(`.${domain}`))) return false;
  }
  if (config.allowedRecipientPatterns.length > 0) {
    const recipients = [...message.to, ...message.cc].join("\n");
    if (!matchesAny(recipients, config.allowedRecipientPatterns)) return false;
  }
  if (config.subjectIncludePatterns.length > 0 && !matchesAny(message.subject, config.subjectIncludePatterns)) return false;
  return true;
}

export async function importEmailMessage(input: {
  host: IntakeHost;
  companyId: string;
  config: CouncilEmailIntakeConfig;
  message: CouncilEmailMessage;
  actor?: { actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null };
}): Promise<"imported" | "duplicate_skipped" | "not_candidate"> {
  const { host, companyId, config, message, actor } = input;
  if (!isCandidateEmail(message, config)) return "not_candidate";

  const link = await reserveLink(host, companyId, message);
  const existingByOrigin = await host.issues.list({
    companyId,
    originKind: ORIGIN_KIND_EMAIL,
    originId: message.sourceMessageId,
    includePluginOperations: true,
    limit: 2,
  });
  const existing = link.paperclip_issue_id
    ? existingByOrigin.find((candidate) => candidate.id === link.paperclip_issue_id) ?? existingByOrigin[0] ?? null
    : existingByOrigin[0] ?? null;
  if (existing) {
    if (link.paperclip_issue_id !== existing.id) await setLinkedIssue(host, companyId, link.id, existing.id, message);
    return "duplicate_skipped";
  }

  const created = await host.issues.create({
    companyId,
    projectId: config.projectId ?? undefined,
    title: emailIssueTitle(message),
    description: emailIssueDescription(message),
    status: config.triageAgentId ? "todo" : "backlog",
    priority: config.defaultPriority,
    assigneeAgentId: config.triageAgentId ?? undefined,
    originKind: ORIGIN_KIND_EMAIL,
    originId: message.sourceMessageId,
    actor,
  });
  await setLinkedIssue(host, companyId, link.id, created.id, message);

  if (config.triageAgentId) {
    await host.issues.requestWakeup(created.id, companyId, {
      reason: "council_email_intake_triage",
      contextSource: PLUGIN_ID,
      idempotencyKey: `council-email:${message.sourceMessageId}`,
      ...actor,
    });
  }
  return "imported";
}

export async function runEmailIntake(input: {
  host: IntakeHost;
  companyId: string;
  config: CouncilEmailIntakeConfig;
  messages: CouncilEmailMessage[];
  triggerKind: "webhook" | "manual";
  actor?: { actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null };
}): Promise<IntakeSummary> {
  const { host, companyId, config, triggerKind, actor } = input;
  const startedAt = new Date().toISOString();
  if (!config.enabled) {
    const summary: IntakeSummary = { triggerKind, status: "skipped", startedAt, finishedAt: new Date().toISOString(), importedCount: 0, skippedDuplicateCount: 0, skippedNonCandidateCount: 0, failedCount: 0, failures: [], disabled: true };
    await recordRun(host, companyId, summary);
    return summary;
  }

  const summary: IntakeSummary = { triggerKind, status: "success", startedAt, finishedAt: startedAt, importedCount: 0, skippedDuplicateCount: 0, skippedNonCandidateCount: 0, failedCount: 0, failures: [] };
  for (const message of input.messages.slice(0, config.maxMessagesPerWebhook)) {
    try {
      const result = await importEmailMessage({ host, companyId, config, message, actor });
      if (result === "imported") summary.importedCount += 1;
      else if (result === "duplicate_skipped") summary.skippedDuplicateCount += 1;
      else summary.skippedNonCandidateCount += 1;
    } catch (err) {
      summary.failedCount += 1;
      summary.failures.push(`${message.sourceMessageId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (summary.failedCount > 0) summary.status = "failed";
  summary.finishedAt = new Date().toISOString();
  await recordRun(host, companyId, summary, { messageCount: input.messages.length });
  await host.state.set({ scopeKind: "company", scopeId: companyId, namespace: "council-email-intake", stateKey: "last-intake" }, summary);
  await host.activity?.log({
    companyId,
    message: `Council email intake completed: ${summary.importedCount} imported, ${summary.skippedDuplicateCount} duplicates skipped, ${summary.skippedNonCandidateCount} non-candidates skipped.`,
    metadata: summary,
  });
  await host.metrics?.write("council_email_intake.imported", summary.importedCount, { triggerKind });
  await host.metrics?.write("council_email_intake.failures", summary.failedCount, { triggerKind });
  await host.telemetry?.track("council-email-intake-completed", {
    triggerKind,
    imported: summary.importedCount,
    duplicates: summary.skippedDuplicateCount,
    nonCandidates: summary.skippedNonCandidateCount,
    failed: summary.failedCount,
  });
  if (summary.failedCount > 0) throw new Error(summary.failures.join("; "));
  return summary;
}

export async function readIntakeStatus(host: IntakeHost, companyId: string): Promise<Record<string, unknown>> {
  const [state, recentRuns, linkCounts] = await Promise.all([
    host.state.get({ scopeKind: "company", scopeId: companyId, namespace: "council-email-intake", stateKey: "last-intake" }),
    host.db.query(`SELECT id, trigger_kind, started_at, finished_at, status, imported_count, skipped_duplicate_count, skipped_non_candidate_count, failed_count, failure_summary FROM ${table(host, "intake_runs")} WHERE company_id = $1 ORDER BY started_at DESC LIMIT 10`, [companyId]),
    host.db.query<{ status: string; count: string }>(`SELECT status, count(*)::text AS count FROM ${table(host, "email_links")} WHERE company_id = $1 GROUP BY status`, [companyId]),
  ]);
  return { state, recentRuns, linkCounts };
}

function expandPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const obj = payload as Record<string, unknown>;
  const pubsubMessage = obj.message && typeof obj.message === "object" ? obj.message as Record<string, unknown> : null;
  const data = pubsubMessage?.data ?? obj.data;
  if (typeof data === "string" && /^[A-Za-z0-9+/=_-]+$/.test(data)) {
    try {
      return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    } catch {
      return payload;
    }
  }
  return payload;
}

function normalizeMessage(input: unknown): CouncilEmailMessage | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const headers = obj.headers && typeof obj.headers === "object" ? obj.headers as Record<string, unknown> : {};
  const sourceMessageId = firstString(obj.sourceMessageId, obj.messageId, obj.id, obj.gmailMessageId, headers["Message-ID"], headers["Message-Id"]);
  if (!sourceMessageId) return null;
  const subject = firstString(obj.subject, headers.Subject) ?? "(no subject)";
  const from = firstString(obj.from, obj.sender, headers.From);
  const to = stringList(obj.to).concat(stringList(headers.To));
  const cc = stringList(obj.cc).concat(stringList(headers.Cc));
  const receivedAt = dateString(firstString(obj.receivedAt, obj.internalDate, obj.date, headers.Date));
  return {
    sourceMessageId,
    sourceThreadId: firstString(obj.sourceThreadId, obj.threadId, obj.gmailThreadId) ?? null,
    from,
    to: unique(to),
    cc: unique(cc),
    subject,
    textBody: firstString(obj.textBody, obj.text, obj.body, obj.snippet),
    htmlBody: firstString(obj.htmlBody, obj.html),
    receivedAt,
    labels: stringList(obj.labels, obj.labelIds),
    url: firstString(obj.url, obj.webUrl, obj.gmailUrl),
    raw: obj,
  };
}

function emailIssueTitle(message: CouncilEmailMessage): string {
  return `[Council email] ${message.subject}`.slice(0, 240);
}

function emailIssueDescription(message: CouncilEmailMessage): string {
  const recipients = [...message.to, ...message.cc.map((item) => `cc:${item}`)];
  return [
    `Imported from council email message ${message.sourceMessageId}.`,
    message.sourceThreadId ? `Thread: ${message.sourceThreadId}` : null,
    message.from ? `From: ${message.from}` : null,
    recipients.length > 0 ? `Recipients: ${recipients.join(", ")}` : null,
    message.receivedAt ? `Received: ${message.receivedAt}` : null,
    message.url ? `Source URL: ${message.url}` : null,
    "",
    message.textBody?.trim() || stripHtml(message.htmlBody) || "No email body provided.",
  ].filter((line): line is string => line !== null).join("\n");
}

async function reserveLink(host: IntakeHost, companyId: string, message: CouncilEmailMessage): Promise<EmailLinkRow> {
  const rows = await host.db.query<EmailLinkRow>(
    `INSERT INTO ${table(host, "email_links")} (id, company_id, source_message_id, source_thread_id, subject, sender, received_at, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, 'reserved', $8::jsonb)
     ON CONFLICT (company_id, source_message_id) DO UPDATE SET
       source_thread_id = COALESCE(EXCLUDED.source_thread_id, ${table(host, "email_links")}.source_thread_id),
       subject = EXCLUDED.subject,
       sender = EXCLUDED.sender,
       received_at = COALESCE(EXCLUDED.received_at, ${table(host, "email_links")}.received_at),
       metadata = ${table(host, "email_links")}.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING id, company_id, source_message_id, source_thread_id, paperclip_issue_id, status`,
    [randomUUID(), companyId, message.sourceMessageId, message.sourceThreadId, message.subject, message.from, message.receivedAt, JSON.stringify({ labels: message.labels, url: message.url })],
  );
  const row = rows[0];
  if (!row) throw new Error(`Failed to reserve email link for ${message.sourceMessageId}`);
  return row;
}

async function setLinkedIssue(host: IntakeHost, companyId: string, linkId: string, paperclipIssueId: string, message: CouncilEmailMessage): Promise<void> {
  await host.db.execute(
    `UPDATE ${table(host, "email_links")}
     SET paperclip_issue_id = $1, source_thread_id = $2, subject = $3, sender = $4, received_at = $5::timestamptz, last_imported_at = now(), status = 'linked', updated_at = now()
     WHERE id = $6 AND company_id = $7`,
    [paperclipIssueId, message.sourceThreadId, message.subject, message.from, message.receivedAt, linkId, companyId],
  );
}

async function recordRun(host: IntakeHost, companyId: string, summary: IntakeSummary, details: Record<string, unknown> = {}): Promise<void> {
  await host.db.execute(
    `INSERT INTO ${table(host, "intake_runs")} (id, company_id, trigger_kind, started_at, finished_at, status, imported_count, skipped_duplicate_count, skipped_non_candidate_count, failed_count, failure_summary, details)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [randomUUID(), companyId, summary.triggerKind, summary.startedAt, summary.finishedAt, summary.status, summary.importedCount, summary.skippedDuplicateCount, summary.skippedNonCandidateCount, summary.failedCount, summary.failures.join("\n").slice(0, 4000) || null, JSON.stringify(details)],
  );
}

function table(host: IntakeHost, name: "email_links" | "intake_runs"): string {
  return `${quoteIdent(host.db.namespace)}.${quoteIdent(name)}`;
}

function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
  return `"${identifier.replaceAll('"', '""')}"`;
}

function headerValue(headers: Record<string, string | string[]>, key: string): string | null {
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  if (Array.isArray(found)) return found[0] ?? null;
  return typeof found === "string" ? found : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function stringList(...values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    if (typeof value !== "string") return [];
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function dateString(value: string | null): string | null {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && /^\d+$/.test(value) ? new Date(numeric) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function emailDomain(value: string): string | null {
  const match = value.match(/@([^>\s]+)>?$/);
  return match?.[1]?.toLowerCase() ?? null;
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return value.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

function stripHtml(value: string | null): string | null {
  if (!value) return null;
  const stripped = value.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > 0 ? stripped : null;
}
