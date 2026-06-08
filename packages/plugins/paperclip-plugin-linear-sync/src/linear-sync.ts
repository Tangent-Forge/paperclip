import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Issue } from "@paperclipai/plugin-sdk";
import { ORIGIN_KIND_INCIDENT, ORIGIN_KIND_LINEAR_ISSUE, PLUGIN_ID } from "./constants.js";

export type LinearSyncConfig = {
  enabled: boolean;
  companyId: string | null;
  linearApiKeySecretRef: string | null;
  linearWebhookSigningSecretRef: string | null;
  linearGraphqlUrl: string;
  candidateStatusNames: string[];
  maxIssuesPerRun: number;
  projectId: string | null;
  triageAgentId: string | null;
  defaultPriority: "low" | "medium" | "high" | "critical";
  postImportComment: boolean;
  importedStateId: string | null;
  failureIncidentThreshold: number;
  failureCooldownMinutes: number;
  successLookbackMinutes: number;
};

export type LinearIssue = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  url: string | null;
  priority: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  state: { id?: string | null; name?: string | null } | null;
  team: { id?: string | null; key?: string | null; name?: string | null } | null;
};

export type SyncSummary = {
  triggerKind: "poll" | "webhook" | "manual";
  status: "success" | "skipped" | "failed";
  startedAt: string;
  finishedAt: string;
  importedCount: number;
  updatedCount: number;
  skippedDuplicateCount: number;
  failedCount: number;
  failures: string[];
  disabled?: boolean;
  cooldownUntil?: string | null;
};

type LinkRow = {
  id: string;
  company_id: string;
  linear_issue_id: string;
  linear_identifier: string | null;
  paperclip_issue_id: string | null;
  last_linear_updated_at: string | null;
  status: string;
  metadata: unknown;
};

type SyncState = {
  lastSuccessAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastSummary?: SyncSummary;
  consecutiveFailures?: number;
  lastFailureAt?: string;
  lastFailureMessage?: string;
  cooldownUntil?: string | null;
  incidentIssueId?: string | null;
};

export type LinearClient = {
  listCandidateIssues(input: { stateNames: string[]; first: number; updatedAfter?: string | null }): Promise<LinearIssue[]>;
  getIssue(issueId: string): Promise<LinearIssue | null>;
  postImportComment(issueId: string, body: string): Promise<void>;
  moveIssueToState(issueId: string, stateId: string): Promise<void>;
};

export type SyncHost = {
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
    update(issueId: string, patch: Partial<Pick<Issue, "title" | "description" | "status" | "priority" | "assigneeAgentId" | "originKind" | "originId">>, companyId: string, actor?: { actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null }): Promise<Issue>;
    requestWakeup(issueId: string, companyId: string, options?: { reason?: string; contextSource?: string; idempotencyKey?: string | null; actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null }): Promise<{ queued: boolean }>;
  };
  state: {
    get(input: { scopeKind: "company"; scopeId: string; namespace?: string; stateKey: string }): Promise<unknown>;
    set(input: { scopeKind: "company"; scopeId: string; namespace?: string; stateKey: string }, value: unknown): Promise<void>;
  };
  activity: { log(entry: { companyId: string; message: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> }): Promise<void> };
  metrics?: { write(name: string, value: number, tags?: Record<string, string>): Promise<void> };
  telemetry?: { track(eventName: string, dimensions?: Record<string, string | number | boolean>): Promise<void> };
  logger?: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void; error(message: string, meta?: Record<string, unknown>): void };
};

export function readConfig(raw: Record<string, unknown>): LinearSyncConfig {
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
  const str = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  const int = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(parsed)));
  };
  const priority = str(raw.defaultPriority);
  return {
    enabled: raw.enabled === true,
    companyId: str(raw.companyId),
    linearApiKeySecretRef: str(raw.linearApiKeySecretRef),
    linearWebhookSigningSecretRef: str(raw.linearWebhookSigningSecretRef),
    linearGraphqlUrl: str(raw.linearGraphqlUrl) ?? "https://api.linear.app/graphql",
    candidateStatusNames: strings(raw.candidateStatusNames).length > 0 ? strings(raw.candidateStatusNames) : ["Backlog", "Todo"],
    maxIssuesPerRun: int(raw.maxIssuesPerRun, 25, 1, 100),
    projectId: str(raw.projectId),
    triageAgentId: str(raw.triageAgentId),
    defaultPriority: priority === "low" || priority === "medium" || priority === "high" || priority === "critical" ? priority : "medium",
    postImportComment: raw.postImportComment !== false,
    importedStateId: str(raw.importedStateId),
    failureIncidentThreshold: int(raw.failureIncidentThreshold, 3, 1, 25),
    failureCooldownMinutes: int(raw.failureCooldownMinutes, 60, 1, 1440),
    successLookbackMinutes: int(raw.successLookbackMinutes, 60, 1, 10080),
  };
}

export function isCandidateLinearIssue(issue: LinearIssue, config: LinearSyncConfig): boolean {
  const stateName = issue.state?.name?.trim().toLowerCase();
  return Boolean(stateName && config.candidateStatusNames.some((name) => name.trim().toLowerCase() === stateName));
}

export function verifyLinearSignature(input: { rawBody: string; headers: Record<string, string | string[]>; secret: string }): boolean {
  const signature = headerValue(input.headers, "linear-signature") ?? headerValue(input.headers, "x-linear-signature");
  if (!signature) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const actual = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

function headerValue(headers: Record<string, string | string[]>, key: string): string | null {
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  if (Array.isArray(found)) return found[0] ?? null;
  return typeof found === "string" ? found : null;
}

function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
  return `"${identifier.replaceAll('"', '""')}"`;
}

function table(host: SyncHost, name: "linear_issue_links" | "sync_runs"): string {
  return `${quoteIdent(host.db.namespace)}.${quoteIdent(name)}`;
}

async function getState(host: SyncHost, companyId: string): Promise<SyncState> {
  const value = await host.state.get({ scopeKind: "company", scopeId: companyId, namespace: "linear-sync", stateKey: "sync-state" });
  return value && typeof value === "object" ? value as SyncState : {};
}

async function setState(host: SyncHost, companyId: string, state: SyncState): Promise<void> {
  await host.state.set({ scopeKind: "company", scopeId: companyId, namespace: "linear-sync", stateKey: "sync-state" }, state);
}

function linearTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function paperclipDescription(issue: LinearIssue): string {
  const lines = [
    `Imported from Linear issue ${issue.identifier ?? issue.id}.`,
    issue.url ? `Linear URL: ${issue.url}` : null,
    issue.state?.name ? `Linear status at import: ${issue.state.name}` : null,
    issue.team?.key || issue.team?.name ? `Linear team: ${issue.team?.key ?? issue.team?.name}` : null,
    "",
    issue.description?.trim() || "No Linear description provided.",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function shouldUpdateLinkedIssue(link: LinkRow, issue: LinearIssue): boolean {
  const linkedUpdatedAt = link.last_linear_updated_at ? new Date(link.last_linear_updated_at).getTime() : 0;
  const issueUpdatedAt = issue.updatedAt ? new Date(issue.updatedAt).getTime() : 0;
  return issueUpdatedAt > linkedUpdatedAt;
}

async function reserveLink(host: SyncHost, companyId: string, issue: LinearIssue): Promise<LinkRow> {
  const rows = await host.db.query<LinkRow>(
    `INSERT INTO ${table(host, "linear_issue_links")} (id, company_id, linear_issue_id, linear_identifier, last_linear_updated_at, status, metadata)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 'reserved', $6::jsonb)
     ON CONFLICT (company_id, linear_issue_id) DO UPDATE SET
       linear_identifier = EXCLUDED.linear_identifier,
       last_linear_updated_at = GREATEST(${table(host, "linear_issue_links")}.last_linear_updated_at, EXCLUDED.last_linear_updated_at),
       metadata = ${table(host, "linear_issue_links")}.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING id, company_id, linear_issue_id, linear_identifier, paperclip_issue_id, last_linear_updated_at, status, metadata`,
    [randomUUID(), companyId, issue.id, issue.identifier, linearTimestamp(issue.updatedAt), JSON.stringify({ latestLinearUrl: issue.url, latestStateName: issue.state?.name ?? null })],
  );
  const row = rows[0];
  if (!row) throw new Error(`Failed to reserve Linear issue link for ${issue.id}`);
  return row;
}

async function setLinkedIssue(host: SyncHost, companyId: string, linkId: string, paperclipIssueId: string, issue: LinearIssue): Promise<void> {
  await host.db.execute(
    `UPDATE ${table(host, "linear_issue_links")}
     SET paperclip_issue_id = $1, linear_identifier = $2, last_linear_updated_at = $3::timestamptz, last_imported_at = now(), status = 'linked', updated_at = now()
     WHERE id = $4 AND company_id = $5`,
    [paperclipIssueId, issue.identifier, linearTimestamp(issue.updatedAt), linkId, companyId],
  );
}

async function markLinearWrite(host: SyncHost, companyId: string, linkId: string): Promise<void> {
  await host.db.execute(
    `UPDATE ${table(host, "linear_issue_links")}
     SET last_synced_to_linear_at = now(), updated_at = now()
     WHERE id = $1 AND company_id = $2`,
    [linkId, companyId],
  );
}

export async function importLinearIssue(input: {
  host: SyncHost;
  linear: LinearClient;
  companyId: string;
  config: LinearSyncConfig;
  issue: LinearIssue;
  actor?: { actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null };
}): Promise<"imported" | "updated" | "duplicate_skipped" | "not_candidate"> {
  const { host, linear, companyId, config, issue, actor } = input;
  if (!isCandidateLinearIssue(issue, config)) return "not_candidate";

  const link = await reserveLink(host, companyId, issue);
  const existingByOrigin = await host.issues.list({
    companyId,
    originKind: ORIGIN_KIND_LINEAR_ISSUE,
    originId: issue.id,
    includePluginOperations: true,
    limit: 2,
  });
  const existing = link.paperclip_issue_id
    ? existingByOrigin.find((candidate) => candidate.id === link.paperclip_issue_id) ?? existingByOrigin[0] ?? null
    : existingByOrigin[0] ?? null;

  if (existing) {
    if (link.paperclip_issue_id !== existing.id) {
      await setLinkedIssue(host, companyId, link.id, existing.id, issue);
    }
    if (!shouldUpdateLinkedIssue(link, issue)) return "duplicate_skipped";
    await host.issues.update(existing.id, {
      title: `[${issue.identifier ?? "Linear"}] ${issue.title}`,
      description: paperclipDescription(issue),
      originKind: ORIGIN_KIND_LINEAR_ISSUE,
      originId: issue.id,
    }, companyId, actor);
    await setLinkedIssue(host, companyId, link.id, existing.id, issue);
    return "updated";
  }

  const created = await host.issues.create({
    companyId,
    projectId: config.projectId ?? undefined,
    title: `[${issue.identifier ?? "Linear"}] ${issue.title}`,
    description: paperclipDescription(issue),
    status: config.triageAgentId ? "todo" : "backlog",
    priority: config.defaultPriority,
    assigneeAgentId: config.triageAgentId ?? undefined,
    originKind: ORIGIN_KIND_LINEAR_ISSUE,
    originId: issue.id,
    actor,
  });
  await setLinkedIssue(host, companyId, link.id, created.id, issue);

  if (config.triageAgentId) {
    await host.issues.requestWakeup(created.id, companyId, {
      reason: "linear_imported_intake_triage",
      contextSource: PLUGIN_ID,
      idempotencyKey: `linear-triage:${issue.id}`,
      ...actor,
    });
  }

  if (config.postImportComment) {
    await linear.postImportComment(
      issue.id,
      `Imported into Paperclip as ${created.identifier ?? created.id}. Agents will triage this intake item in Paperclip before routing implementation work.`,
    );
    await markLinearWrite(host, companyId, link.id);
  }
  if (config.importedStateId) {
    await linear.moveIssueToState(issue.id, config.importedStateId);
    await markLinearWrite(host, companyId, link.id);
  }

  return "imported";
}

async function recordRun(host: SyncHost, companyId: string, summary: SyncSummary, details: Record<string, unknown> = {}): Promise<void> {
  await host.db.execute(
    `INSERT INTO ${table(host, "sync_runs")} (id, company_id, trigger_kind, started_at, finished_at, status, imported_count, updated_count, skipped_duplicate_count, failed_count, failure_summary, details)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [randomUUID(), companyId, summary.triggerKind, summary.startedAt, summary.finishedAt, summary.status, summary.importedCount, summary.updatedCount, summary.skippedDuplicateCount, summary.failedCount, summary.failures.join("\n").slice(0, 4000) || null, JSON.stringify(details)],
  );
}

async function handleSyncFailure(host: SyncHost, companyId: string, config: LinearSyncConfig, summary: SyncSummary, errorMessage: string): Promise<void> {
  const previous = await getState(host, companyId);
  const consecutiveFailures = (previous.consecutiveFailures ?? 0) + 1;
  const cooldownUntil = new Date(Date.now() + config.failureCooldownMinutes * 60_000).toISOString();
  let incidentIssueId = previous.incidentIssueId ?? null;

  if (consecutiveFailures >= config.failureIncidentThreshold) {
    const title = "Linear sync integration failing";
    const description = [
      `Linear sync has failed ${consecutiveFailures} consecutive time(s).`,
      `Cooldown until: ${cooldownUntil}`,
      "",
      "Latest failure:",
      errorMessage,
      "",
      "Next action: fix plugin configuration, Linear API credentials, or network reachability, then run a manual sync. This single incident suppresses repeated routine spam while the integration is broken.",
    ].join("\n");

    if (incidentIssueId) {
      await host.issues.update(incidentIssueId, { title, description, status: "blocked", priority: "high" }, companyId);
    } else {
      const existing = await host.issues.list({ companyId, originKind: ORIGIN_KIND_INCIDENT, originId: `linear-sync:${companyId}`, limit: 1, includePluginOperations: true });
      if (existing[0]) {
        incidentIssueId = existing[0].id;
        await host.issues.update(incidentIssueId, { title, description, status: "blocked", priority: "high" }, companyId);
      } else {
        const incident = await host.issues.create({
          companyId,
          projectId: config.projectId ?? undefined,
          title,
          description,
          status: "blocked",
          priority: "high",
          originKind: ORIGIN_KIND_INCIDENT,
          originId: `linear-sync:${companyId}`,
        });
        incidentIssueId = incident.id;
      }
    }
  }

  await setState(host, companyId, {
    ...previous,
    lastStartedAt: summary.startedAt,
    lastFinishedAt: summary.finishedAt,
    lastSummary: summary,
    consecutiveFailures,
    lastFailureAt: summary.finishedAt,
    lastFailureMessage: errorMessage,
    cooldownUntil,
    incidentIssueId,
  });
}

export async function runLinearSync(input: {
  host: SyncHost;
  linear: LinearClient;
  companyId: string;
  config: LinearSyncConfig;
  triggerKind: "poll" | "manual";
  actor?: { actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null };
}): Promise<SyncSummary> {
  const { host, linear, companyId, config, triggerKind, actor } = input;
  const startedAt = new Date().toISOString();
  const state = await getState(host, companyId);
  if (!config.enabled) {
    const summary: SyncSummary = { triggerKind, status: "skipped", startedAt, finishedAt: new Date().toISOString(), importedCount: 0, updatedCount: 0, skippedDuplicateCount: 0, failedCount: 0, failures: [], disabled: true };
    await recordRun(host, companyId, summary);
    await setState(host, companyId, { ...state, lastStartedAt: startedAt, lastFinishedAt: summary.finishedAt, lastSummary: summary });
    return summary;
  }
  if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > Date.now()) {
    const summary: SyncSummary = { triggerKind, status: "skipped", startedAt, finishedAt: new Date().toISOString(), importedCount: 0, updatedCount: 0, skippedDuplicateCount: 0, failedCount: 0, failures: [], cooldownUntil: state.cooldownUntil };
    await recordRun(host, companyId, summary, { reason: "cooldown" });
    return summary;
  }

  const summary: SyncSummary = { triggerKind, status: "success", startedAt, finishedAt: startedAt, importedCount: 0, updatedCount: 0, skippedDuplicateCount: 0, failedCount: 0, failures: [] };
  try {
    const updatedAfter = state.lastSuccessAt
      ? new Date(Math.max(0, new Date(state.lastSuccessAt).getTime() - config.successLookbackMinutes * 60_000)).toISOString()
      : null;
    const issues = await linear.listCandidateIssues({ stateNames: config.candidateStatusNames, first: config.maxIssuesPerRun, updatedAfter });
    for (const issue of issues.slice(0, config.maxIssuesPerRun)) {
      try {
        const result = await importLinearIssue({ host, linear, companyId, config, issue, actor });
        if (result === "imported") summary.importedCount += 1;
        else if (result === "updated") summary.updatedCount += 1;
        else if (result === "duplicate_skipped") summary.skippedDuplicateCount += 1;
      } catch (err) {
        summary.failedCount += 1;
        summary.failures.push(`${issue.identifier ?? issue.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (summary.failedCount > 0) throw new Error(summary.failures.join("; "));
    summary.finishedAt = new Date().toISOString();
    await recordRun(host, companyId, summary, { updatedAfter, candidateStatusNames: config.candidateStatusNames });
    await setState(host, companyId, { ...state, lastStartedAt: startedAt, lastFinishedAt: summary.finishedAt, lastSuccessAt: summary.finishedAt, lastSummary: summary, consecutiveFailures: 0, cooldownUntil: null });
    await host.activity.log({ companyId, message: `Linear sync completed: ${summary.importedCount} imported, ${summary.updatedCount} updated, ${summary.skippedDuplicateCount} duplicates skipped.`, metadata: summary });
    await host.metrics?.write("linear_sync.imported", summary.importedCount, { triggerKind });
    await host.metrics?.write("linear_sync.failures", summary.failedCount, { triggerKind });
    await host.telemetry?.track("linear-sync-completed", { triggerKind, imported: summary.importedCount, updated: summary.updatedCount, skipped: summary.skippedDuplicateCount });
    return summary;
  } catch (err) {
    summary.status = "failed";
    summary.finishedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    if (summary.failures.length === 0) summary.failures.push(message);
    await recordRun(host, companyId, summary);
    await handleSyncFailure(host, companyId, config, summary, message);
    await host.metrics?.write("linear_sync.failures", Math.max(1, summary.failedCount), { triggerKind });
    await host.telemetry?.track("linear-sync-failed", { triggerKind, failed: Math.max(1, summary.failedCount) });
    throw err;
  }
}

export async function handleWebhookIssue(input: {
  host: SyncHost;
  linear: LinearClient;
  companyId: string;
  config: LinearSyncConfig;
  payload: unknown;
}): Promise<SyncSummary> {
  const startedAt = new Date().toISOString();
  const issueId = extractLinearIssueId(input.payload);
  if (!issueId) throw new Error("Linear webhook did not contain an issue id");
  const linearIssue = await input.linear.getIssue(issueId);
  if (!linearIssue) throw new Error(`Linear issue not found: ${issueId}`);
  const result = await importLinearIssue({ ...input, issue: linearIssue });
  const summary: SyncSummary = {
    triggerKind: "webhook",
    status: result === "not_candidate" ? "skipped" : "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    importedCount: result === "imported" ? 1 : 0,
    updatedCount: result === "updated" ? 1 : 0,
    skippedDuplicateCount: result === "duplicate_skipped" ? 1 : 0,
    failedCount: 0,
    failures: [],
  };
  await recordRun(input.host, input.companyId, summary, { linearIssueId: issueId, result });
  const state = await getState(input.host, input.companyId);
  await setState(input.host, input.companyId, { ...state, lastStartedAt: startedAt, lastFinishedAt: summary.finishedAt, lastSuccessAt: summary.finishedAt, lastSummary: summary, consecutiveFailures: 0, cooldownUntil: null });
  return summary;
}

function extractLinearIssueId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const data = obj.data && typeof obj.data === "object" ? obj.data as Record<string, unknown> : obj;
  const id = data.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  const issue = data.issue && typeof data.issue === "object" ? data.issue as Record<string, unknown> : null;
  return typeof issue?.id === "string" && issue.id.trim() ? issue.id.trim() : null;
}

export async function readSyncStatus(host: SyncHost, companyId: string): Promise<Record<string, unknown>> {
  const [state, recentRuns, linkCounts] = await Promise.all([
    getState(host, companyId),
    host.db.query(`SELECT id, trigger_kind, started_at, finished_at, status, imported_count, updated_count, skipped_duplicate_count, failed_count, failure_summary FROM ${table(host, "sync_runs")} WHERE company_id = $1 ORDER BY started_at DESC LIMIT 10`, [companyId]),
    host.db.query<{ status: string; count: string }>(`SELECT status, count(*)::text AS count FROM ${table(host, "linear_issue_links")} WHERE company_id = $1 GROUP BY status`, [companyId]),
  ]);
  return { state, recentRuns, linkCounts };
}
