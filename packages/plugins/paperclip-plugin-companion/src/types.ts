// Host abstraction consumed by companion-service.ts. Kept as a narrow
// interface (mirroring the paperclip-plugin-linear-sync pattern) so the
// service logic is testable against an in-memory fake host without a live
// Paperclip instance, while worker.ts wires the real `ctx.*` clients in.
import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

export interface CompanionIssueSummary {
  id: string;
  title: string;
  status: string;
}

export interface CompanionInteractionResult {
  id: string;
}

export interface CompanionRespondResult {
  interaction: { id: string; status: string };
  applied: boolean;
}

export interface CompanionAgentSummary {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface CompanionHttpResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export interface CompanionLocalFolderStatus {
  configured: boolean;
  healthy: boolean;
}

export interface CompanionLocalFolderEntry {
  path: string;
  isDirectory: boolean;
}

export interface CompanionHost {
  db: {
    /**
     * The plugin's host-provisioned Postgres schema name (e.g.
     * "plugin_companion_46345b9b3b"). Every query/execute statement below
     * must qualify its own table references with this — the host's runtime
     * SQL validator requires fully schema-qualified identifiers, exactly
     * like it requires for this plugin's own migration DDL. See
     * companion-service.ts's `table()` helper.
     */
    namespace: string;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  };
  issues: {
    list(input: { companyId: string; q?: string; limit?: number }): Promise<CompanionIssueSummary[]>;
    create(input: {
      companyId: string;
      title: string;
      description?: string;
      idempotencyKey?: string | null;
      allowDuplicate?: boolean;
    }): Promise<CompanionIssueSummary>;
    requestConfirmation(
      issueId: string,
      interaction: {
        title: string;
        summary: string;
        idempotencyKey: string;
        // No agent is assigned to the standing Companion issue, so there is
        // nothing to wake — this interaction exists only for a human to see
        // and decide.
        continuationPolicy: "none";
        payload: { version: 1; prompt: string; allowDeclineReason: boolean; detailsMarkdown?: string | null };
      },
      companyId: string,
    ): Promise<CompanionInteractionResult>;
    respondInteraction(
      issueId: string,
      interactionId: string,
      input: { action: "accept" | "reject"; actorUserId?: string; reason?: string | null },
      companyId: string,
    ): Promise<CompanionRespondResult>;
  };
  agents: {
    list(input: { companyId: string; status?: string; limit?: number }): Promise<CompanionAgentSummary[]>;
  };
  activity: {
    log(entry: {
      companyId: string;
      message: string;
      entityType?: string;
      entityId?: string;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  secrets: {
    /**
     * secretRef must be the resolved `{ type: "secret_ref", secretId,
     * version? }` binding object — see config-validation.ts's
     * parseSecretRefBinding. A raw string is accepted here only for
     * flexibility in tests; the real host's resolve() throws on one.
     */
    resolve(secretRef: string | EnvSecretRefBinding, opts: { companyId: string }): Promise<string | null>;
  };
  http: {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<CompanionHttpResponse>;
  };
  localFolders: {
    status(companyId: string, folderKey: string): Promise<CompanionLocalFolderStatus>;
    readText(companyId: string, folderKey: string, relativePath: string): Promise<string>;
    list(companyId: string, folderKey: string): Promise<CompanionLocalFolderEntry[]>;
  };
  config: {
    get(companyId?: string): Promise<Record<string, unknown>>;
  };
  now(): Date;
}

export interface CompanionEvidenceRef {
  source: "deployment_health" | "github" | "local_artifact" | "agents" | "issues";
  fetchedAtUTC: string;
  scope: { companyId: string };
  identity?: { commitSha?: string; prNumber?: number; path?: string };
  success: boolean;
  summary: string;
  redactedError?: string;
}

export interface CompanionThreadRow {
  id: string;
  company_id: string;
  title: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CompanionMessageRow {
  id: string;
  company_id: string;
  thread_id: string;
  role: "human" | "companion";
  actor_user_id: string | null;
  body: string;
  evidence: CompanionEvidenceRef[] | null;
  /** Client-supplied idempotency key for the send-message request that produced this row. Null for rows created without one. */
  client_request_id: string | null;
  created_at: string;
}

export interface CompanionActionProposalRow {
  id: string;
  company_id: string;
  thread_id: string;
  message_id: string;
  companion_issue_id: string;
  interaction_id: string;
  summary: string;
  status: "pending" | "accepted" | "rejected";
  decided_by_user_id: string | null;
  decided_at: string | null;
  created_at: string;
}
