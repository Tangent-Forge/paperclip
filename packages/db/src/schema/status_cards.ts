import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  CompanySearchQuery,
  IngestOperationalReceipt,
  OperationalStatus,
  OperationalStatusCardConfig,
  StatusCardRefreshPolicy,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

type StatusCardFingerprint = Record<string, {
  status: string;
  updatedAt: string;
  latestHumanCommentAt?: string | null;
  identifier?: string | null;
  title?: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}>;
type StatusCardUpdateChange = {
  issueId: string;
  identifier: string;
  from: string | null;
  to: string | null;
  changeKind: string;
};

export const statusCards = pgTable(
  "status_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title"),
    kind: text("kind").$type<"issues" | "operational">().notNull().default("issues"),
    titlePinned: boolean("title_pinned").notNull().default(false),
    interestPrompt: text("interest_prompt").notNull(),
    queries: jsonb("queries").$type<CompanySearchQuery[]>().notNull().default(sql`'[]'::jsonb`),
    queryVersion: integer("query_version").notNull().default(0),
    queryCompiledAt: timestamp("query_compiled_at", { withTimezone: true }),
    queryCompiledByAgentId: uuid("query_compiled_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    // Per-card summarizer override; null means the company's built-in Summarizer.
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    refreshPolicy: jsonb("refresh_policy").$type<StatusCardRefreshPolicy>().notNull(),
    state: text("state").$type<"compiling" | "active" | "error" | "paused_budget" | "paused_hours">().notNull().default("compiling"),
    pendingChangeCount: integer("pending_change_count").notNull().default(0),
    pendingChangeHash: text("pending_change_hash"),
    lastChangeAt: timestamp("last_change_at", { withTimezone: true }),
    fingerprint: jsonb("fingerprint").$type<StatusCardFingerprint>(),
    fingerprintAt: timestamp("fingerprint_at", { withTimezone: true }),
    // Issues referenced in the latest summary markdown (by identifier or issue
    // link) that join the watched set alongside the compiled-query matches.
    mentionedIssueIds: jsonb("mentioned_issue_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    lastUpdateRunKind: text("last_update_run_kind").$type<"full" | "incremental">(),
    lastGeneratedAt: timestamp("last_generated_at", { withTimezone: true }),
    lastModel: text("last_model"),
    generatingIssueId: uuid("generating_issue_id").references(() => issues.id, { onDelete: "set null" }),
    failureReason: text("failure_reason"),
    nextEvalAt: timestamp("next_eval_at", { withTimezone: true }),
    operationalConfig: jsonb("operational_config").$type<OperationalStatusCardConfig>(),
    operationalState: text("operational_state").$type<OperationalStatus>(),
    operationalFingerprint: text("operational_fingerprint"),
    operationalFailureStreak: integer("operational_failure_streak").notNull().default(0),
    operationalRecoveryStreak: integer("operational_recovery_streak").notNull().default(0),
    operationalLatestClaimId: uuid("operational_latest_claim_id"),
    operationalExceptionIssueId: uuid("operational_exception_issue_id").references(() => issues.id, { onDelete: "set null" }),
    operationalSummary: text("operational_summary"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: text("archived_by_user_id"),
    archivedByAgentId: uuid("archived_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyArchivedIdx: index("status_cards_company_archived_idx").on(table.companyId, table.archivedAt),
    companyNextEvalIdx: index("status_cards_company_next_eval_idx").on(table.companyId, table.nextEvalAt),
  }),
);

export const operationalReceipts = pgTable(
  "operational_receipts",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    status: text("status").$type<"passed" | "degraded" | "failed">().notNull(),
    summary: text("summary").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    freshUntil: timestamp("fresh_until", { withTimezone: true }).notNull(),
    provenance: jsonb("provenance").$type<IngestOperationalReceipt["provenance"]>().notNull(),
    observation: jsonb("observation").$type<IngestOperationalReceipt["observation"]>().notNull(),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    latestEvidenceIdx: index("operational_receipts_latest_evidence_idx").on(
      table.companyId,
      table.sourceKey,
      table.subjectKey,
      table.observedAt,
    ),
  }),
);

type OperationalReceiptSnapshot = {
  id: string;
  sourceKey: string;
  subjectKey: string;
  status: "passed" | "degraded" | "failed";
  summary: string;
  observedAt: string;
  freshUntil: string;
  provenance: IngestOperationalReceipt["provenance"];
};

export const operationalStatusClaims = pgTable(
  "operational_status_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id").notNull().references(() => statusCards.id, { onDelete: "cascade" }),
    state: text("state").$type<OperationalStatus>().notNull(),
    reason: text("reason").notNull(),
    fingerprint: text("fingerprint").notNull(),
    receiptIds: jsonb("receipt_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    receiptSnapshot: jsonb("receipt_snapshot").$type<OperationalReceiptSnapshot[]>().notNull().default(sql`'[]'::jsonb`),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    freshUntil: timestamp("fresh_until", { withTimezone: true }),
    changed: boolean("changed").notNull(),
    summaryRequired: boolean("summary_required").notNull(),
    summary: text("summary"),
    exceptionIssueId: uuid("exception_issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cardCreatedIdx: index("operational_status_claims_card_created_idx").on(table.cardId, table.createdAt),
  }),
);

export const statusCardUpdates = pgTable(
  "status_card_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id").notNull().references(() => statusCards.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"compile" | "full" | "incremental">().notNull(),
    trigger: text("trigger").$type<"manual" | "interval" | "reactive" | "restore">().notNull(),
    generationIssueId: uuid("generation_issue_id").references(() => issues.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    changes: jsonb("changes").$type<StatusCardUpdateChange[]>().notNull().default(sql`'[]'::jsonb`),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    model: text("model"),
    queryVersion: integer("query_version"),
    changeSummary: text("change_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").$type<"running" | "ok" | "failed">().notNull(),
    error: text("error"),
  },
  (table) => ({
    cardStartedIdx: index("status_card_updates_card_started_idx").on(table.cardId, table.startedAt),
    generationIssueIdx: index("status_card_updates_generation_issue_idx").on(table.generationIssueId),
  }),
);
