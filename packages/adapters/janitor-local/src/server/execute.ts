import path from "node:path";
import fs from "node:fs/promises";
import {
  redactDiagnosticText,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asString, asBoolean, asNumber, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import { runJanitorModule, JANITOR_MODULES, type JanitorModuleId, type JanitorModuleResult } from "./modules.js";

type ApprovalStatus = "pending" | "revision_requested" | "approved" | "rejected" | "cancelled";

interface JanitorActionRecord {
  module: JanitorModuleId;
  action: string;
  target: string;
  description: string;
  risk?: string | null;
  actionId?: string | null;
}

interface JanitorApprovalMetadata {
  version: 2;
  adapterType: "janitor_local";
  agentId: string;
  issueId: string;
  runId: string;
  cwd: string;
  reportPath: string;
  modules: JanitorModuleId[];
  actionCount: number;
  actions: JanitorActionRecord[];
}

interface ApprovalRecord {
  id: string;
  type: string;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote?: string | null;
}

const ADDITIONAL_SECRET_PATTERNS = [
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgsk_[A-Za-z0-9_-]{12,}\b/g,
  /\bxoxb-[0-9]+-[0-9A-Za-z-]+\b/g,
  /\bgumroad_[A-Za-z0-9_]{10,}\b/g,
] as const;

function redactJanitorText(value: string): string {
  let redacted = redactDiagnosticText(value);
  for (const pattern of ADDITIONAL_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "***REDACTED***");
  }
  return redacted.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1***REDACTED***@");
}

function asJanitorModuleIds(value: unknown): JanitorModuleId[] {
  const ids = asStringArray(value);
  if (!ids || ids.length === 0) {
    return JANITOR_MODULES.map((m) => m.id);
  }
  const valid = new Set(JANITOR_MODULES.map((m) => m.id));
  return ids.filter((id): id is JanitorModuleId => valid.has(id as JanitorModuleId));
}

function buildReport(
  results: Array<{ module: string; exitCode: number; stdout: string; stderr: string; durationMs: number }>,
  cwd: string,
  dryRun: boolean,
  footerLines: string[] = [],
): string {
  const lines: string[] = [
    `# Janitor Audit Report`,
    ``,
    `**Workspace:** \`${cwd}\``,
    `**Mode:** ${dryRun ? "Dry-run (read-only)" : "Active"}`,
    `**Date:** ${new Date().toISOString()}`,
    ``,
  ];
  for (const result of results) {
    lines.push(`## Module: ${result.module}`);
    lines.push(`- Exit code: ${result.exitCode}`);
    lines.push(`- Duration: ${result.durationMs}ms`);
    if (result.stdout.trim()) {
      lines.push("", "```", redactJanitorText(result.stdout.trim()), "```");
    }
    if (result.stderr.trim()) {
      lines.push("", "**Errors/Warnings:**", "```", redactJanitorText(result.stderr.trim()), "```");
    }
    lines.push("");
  }
  if (footerLines.length > 0) {
    lines.push("## Approval Gate", "", ...footerLines, "");
  }
  return lines.join("\n");
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isJanitorActionRecord(record: Record<string, unknown>): boolean {
  const marker = readNonEmptyString(record.type) ?? readNonEmptyString(record.kind);
  return marker === "janitor.action" || marker === "janitor_action" || record.janitorAction === true;
}

function parseActionableFindings(results: JanitorModuleResult[]): JanitorActionRecord[] {
  const actions: JanitorActionRecord[] = [];
  for (const result of results) {
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
    for (const line of lines) {
      const record = parseJsonObjectLine(line);
      if (!record || !isJanitorActionRecord(record)) continue;

      const action = readNonEmptyString(record.action);
      const target = readNonEmptyString(record.target) ?? readNonEmptyString(record.path);
      if (!action || !target) continue;

      actions.push({
        module: result.module,
        action,
        target: redactJanitorText(target),
        description: redactJanitorText(readNonEmptyString(record.description) ?? `${action} ${target}`),
        risk: readNonEmptyString(record.risk) ? redactJanitorText(readNonEmptyString(record.risk)!) : null,
        actionId: readNonEmptyString(record.actionId) || readNonEmptyString(record.id)
          ? redactJanitorText(readNonEmptyString(record.actionId) ?? readNonEmptyString(record.id)!)
          : null,
      });
    }
  }
  return actions;
}

function resolvePaperclipApiUrl(): string {
  return (
    process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    "http://localhost:3100"
  ).replace(/\/+$/, "");
}

async function paperclipFetch<T>(
  ctx: AdapterExecutionContext,
  pathName: string,
  init: RequestInit = {},
): Promise<T> {
  if (!ctx.authToken) {
    throw new Error("Janitor approval gate requires ctx.authToken to call the Paperclip API");
  }

  const response = await fetch(`${resolvePaperclipApiUrl()}${pathName}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${ctx.authToken}`,
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": ctx.runId,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const safeDetail = redactJanitorText(text).slice(0, 500);
    throw new Error(`Paperclip API ${init.method ?? "GET"} ${pathName} failed: ${response.status} ${safeDetail}`.trim());
  }
  return await response.json() as T;
}

function approvalMetadata(payload: Record<string, unknown>): JanitorApprovalMetadata | null {
  const metadata = payload.janitorLocalApproval;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (record.version !== 2 || record.adapterType !== "janitor_local") return null;
  const modules = Array.isArray(record.modules)
    ? record.modules.filter((value): value is JanitorModuleId => typeof value === "string" && JANITOR_MODULES.some((m) => m.id === value))
    : [];
  const actions = Array.isArray(record.actions)
    ? record.actions.filter((value): value is JanitorActionRecord => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const action = value as Record<string, unknown>;
        return Boolean(readNonEmptyString(action.module) && readNonEmptyString(action.action) && readNonEmptyString(action.target));
      })
    : [];
  return {
    version: 2,
    adapterType: "janitor_local",
    agentId: readNonEmptyString(record.agentId) ?? "",
    issueId: readNonEmptyString(record.issueId) ?? "",
    runId: readNonEmptyString(record.runId) ?? "",
    cwd: readNonEmptyString(record.cwd) ?? "",
    reportPath: readNonEmptyString(record.reportPath) ?? "",
    modules,
    actionCount: Number(record.actionCount) || actions.length,
    actions,
  };
}

async function getIssueApprovals(ctx: AdapterExecutionContext, issueId: string): Promise<ApprovalRecord[]> {
  return await paperclipFetch<ApprovalRecord[]>(ctx, `/api/issues/${issueId}/approvals`);
}

async function getApproval(ctx: AdapterExecutionContext, approvalId: string): Promise<ApprovalRecord> {
  return await paperclipFetch<ApprovalRecord>(ctx, `/api/approvals/${approvalId}`);
}

async function updateIssueStatus(ctx: AdapterExecutionContext, issueId: string, status: "in_review" | "done", comment: string) {
  await paperclipFetch(ctx, `/api/issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify({ status, comment }),
  });
}

async function createOrReuseApproval(
  ctx: AdapterExecutionContext,
  issueId: string,
  metadata: JanitorApprovalMetadata,
): Promise<ApprovalRecord> {
  const existing = await getIssueApprovals(ctx, issueId);
  const reusable = existing.find((approval) => {
    const existingMetadata = approvalMetadata(approval.payload);
    return (
      approval.type === "request_board_approval" &&
      (approval.status === "pending" || approval.status === "revision_requested") &&
      existingMetadata?.adapterType === "janitor_local" &&
      existingMetadata.agentId === ctx.agent.id &&
      existingMetadata.issueId === issueId &&
      existingMetadata.runId === ctx.runId &&
      existingMetadata.cwd === metadata.cwd
    );
  });
  if (reusable) return reusable;

  return await paperclipFetch<ApprovalRecord>(ctx, `/api/companies/${ctx.agent.companyId}/approvals`, {
    method: "POST",
    body: JSON.stringify({
      type: "request_board_approval",
      requestedByAgentId: ctx.agent.id,
      issueIds: [issueId],
      payload: {
        title: "Approve Janitor write/delete actions",
        summary: `Janitor found ${metadata.actionCount} structured actionable item(s) in ${metadata.modules.length} module(s) for ${metadata.cwd}.`,
        recommendedAction: "Approve only if these workspace cleanup actions are expected and safe. On approval, Janitor will rerun the affected modules with JANITOR_DRY_RUN=0.",
        risks: [
          "Approved modules may modify or delete local workspace files.",
          "Only structured Janitor action records are eligible; prose report text is not trusted for writes.",
        ],
        janitorLocalApproval: metadata,
      },
    }),
  });
}

async function runModules(
  moduleIds: JanitorModuleId[],
  cwd: string,
  extraEnv: Record<string, string>,
  timeoutMs: number,
): Promise<JanitorModuleResult[]> {
  const results: JanitorModuleResult[] = [];
  for (const moduleId of moduleIds) {
    const result = await runJanitorModule(moduleId, cwd, extraEnv, timeoutMs);
    results.push(result);
  }
  return results;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config as Record<string, unknown>;
  const prompt = asString(ctx.context["prompt"] as unknown, "");

  const cwd = path.resolve(asString(config.cwd, process.cwd()));
  const dryRun = asBoolean(config.dryRun, true);
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const reportDir = path.resolve(asString(config.reportDir, path.join(cwd, ".janitor", "reports")));
  const moduleIds = asJanitorModuleIds(config.modules);
  const approvalRequired = asBoolean(config.approvalRequired, true);
  const issueId = readNonEmptyString(ctx.context.issueId) ?? readNonEmptyString(ctx.context.taskId);
  const approvalId = readNonEmptyString(ctx.context.approvalId);
  const approvalStatus = readNonEmptyString(ctx.context.approvalStatus) as ApprovalStatus | null;
  const isApprovalResolution = Boolean(approvalId && (approvalStatus === "approved" || approvalStatus === "rejected"));
  const effectiveDryRun = approvalRequired && !dryRun && !isApprovalResolution ? true : dryRun;
  const activeApprovedRun = approvalRequired && !dryRun && approvalId && approvalStatus === "approved";

  if (!dryRun && !approvalRequired) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "janitor_approval_bypass_forbidden",
      errorMessage: "Janitor active mode cannot disable the board approval gate.",
      summary: "Janitor failed closed: active cleanup always requires board approval.",
    } satisfies AdapterExecutionResult;
  }

  const extraEnv: Record<string, string> = {
    JANITOR_DRY_RUN: effectiveDryRun ? "1" : "0",
    JANITOR_APPROVAL_REQUIRED: approvalRequired ? "1" : "0",
    JANITOR_REPORT_DIR: reportDir,
  };

  if (config.maxStorageAgeDays !== undefined) {
    extraEnv.JANITOR_MAX_AGE_DAYS = String(asNumber(config.maxStorageAgeDays, 90));
  }

  if (config.secretsPatterns !== undefined) {
    extraEnv.JANITOR_EXTRA_PATTERNS = (asStringArray(config.secretsPatterns) ?? []).join(",");
  }

  const reportInsideWorkspace = reportDir === cwd || reportDir.startsWith(`${cwd}${path.sep}`);
  if (!reportInsideWorkspace) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "janitor_report_path_outside_workspace",
      errorMessage: "Janitor reportDir must resolve inside the configured workspace.",
      summary: "Janitor failed closed: the report path is outside the configured workspace.",
    } satisfies AdapterExecutionResult;
  }

  await fs.mkdir(reportDir, { recursive: true });

  if (approvalRequired && !dryRun && !issueId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "janitor_approval_issue_required",
      errorMessage: "Janitor approval gate requires ctx.context.issueId before active write/delete mode can run.",
      summary: "Janitor failed closed: active cleanup requires a linked Paperclip issue for approval.",
    } satisfies AdapterExecutionResult;
  }

  if (approvalRequired && !dryRun && !ctx.authToken) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "janitor_approval_auth_required",
      errorMessage: "Janitor approval gate requires ctx.authToken before active write/delete mode can run.",
      summary: "Janitor failed closed: active cleanup requires Paperclip API auth to create or resolve approval.",
    } satisfies AdapterExecutionResult;
  }

  if (approvalRequired && !dryRun && approvalId && approvalStatus === "rejected") {
    const approval = await getApproval(ctx, approvalId);
    const metadata = approvalMetadata(approval.payload);
    const skippedPath = path.join(reportDir, `approval-skipped-${Date.now()}.md`);
    await fs.writeFile(
      skippedPath,
      [
        "# Janitor Approval Skipped",
        "",
        `**Workspace:** \`${cwd}\``,
        `**Approval:** \`${approvalId}\``,
        `**Status:** ${approval.status}`,
        `**Date:** ${new Date().toISOString()}`,
        "",
        "The board rejected the Janitor write/delete approval. No active modules were run.",
        "",
        metadata ? `Affected modules: ${metadata.modules.map((moduleId) => `\`${moduleId}\``).join(", ")}` : "",
        approval.decisionNote ? `Decision note: ${redactJanitorText(approval.decisionNote)}` : "",
      ].filter(Boolean).join("\n"),
      "utf-8",
    );
    if (issueId) {
      await updateIssueStatus(ctx, issueId, "done", `Janitor approval was rejected. Active cleanup was skipped.\n\n- Approval: \`${approvalId}\`\n- Skipped report: \`${skippedPath}\``);
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `Janitor approval rejected. No active modules were run. Skipped report saved to \`${skippedPath}\`.`,
      resultJson: { janitorApproval: { approvalId, status: approval.status, skipped: true, reportPath: skippedPath } },
    } satisfies AdapterExecutionResult;
  }

  let approvedMetadata: JanitorApprovalMetadata | null = null;
  let modulesToRun = moduleIds;
  if (activeApprovedRun) {
    const approval = await getApproval(ctx, approvalId);
    if (approval.status !== "approved") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "janitor_approval_not_approved",
        errorMessage: `Janitor approval ${approvalId} is ${approval.status}, not approved.`,
        summary: `Janitor failed closed: approval \`${approvalId}\` is ${approval.status}.`,
      } satisfies AdapterExecutionResult;
    }
    approvedMetadata = approvalMetadata(approval.payload);
    if (
      !approvedMetadata ||
      approvedMetadata.agentId !== ctx.agent.id ||
      approvedMetadata.issueId !== issueId ||
      approvedMetadata.cwd !== cwd
    ) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "janitor_approval_scope_mismatch",
        errorMessage: "Janitor approval does not match the current agent, issue, and workspace.",
        summary: "Janitor failed closed: the approved cleanup scope does not match this run.",
      } satisfies AdapterExecutionResult;
    }
    modulesToRun = approvedMetadata?.modules.length ? approvedMetadata.modules : moduleIds;
    extraEnv.JANITOR_DRY_RUN = "0";
  }

  const results = await runModules(modulesToRun, cwd, extraEnv, timeoutSec * 1000);
  const actionableFindings = effectiveDryRun && approvalRequired && !dryRun ? parseActionableFindings(results) : [];

  const footerLines = approvedMetadata
    ? [
        `Approval \`${approvalId}\` was approved.`,
        `Re-ran approved modules in active mode: ${modulesToRun.map((moduleId) => `\`${moduleId}\``).join(", ")}.`,
      ]
    : [];
  const report = buildReport(results, cwd, effectiveDryRun, footerLines);
  const reportPath = path.join(reportDir, `audit-${Date.now()}.md`);
  await fs.writeFile(reportPath, report, "utf-8");

  if (approvalRequired && !dryRun && effectiveDryRun && actionableFindings.length > 0 && issueId) {
    const affectedModules = Array.from(new Set(actionableFindings.map((action) => action.module)));
    const approval = await createOrReuseApproval(ctx, issueId, {
      version: 2,
      adapterType: "janitor_local",
      agentId: ctx.agent.id,
      issueId,
      runId: ctx.runId,
      cwd,
      reportPath,
      modules: affectedModules,
      actionCount: actionableFindings.length,
      actions: actionableFindings,
    });
    await updateIssueStatus(
      ctx,
      issueId,
      "in_review",
      `Janitor found ${actionableFindings.length} structured actionable item(s) and requested board approval before active cleanup.\n\n- Approval: \`${approval.id}\`\n- Dry-run report: \`${reportPath}\`\n- Affected modules: ${affectedModules.map((moduleId) => `\`${moduleId}\``).join(", ")}`,
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `Janitor is waiting for board approval \`${approval.id}\`. Dry-run report saved to \`${reportPath}\`.`,
      resultJson: {
        janitorApproval: {
          approvalId: approval.id,
          status: approval.status,
          waiting: true,
          reportPath,
          modules: affectedModules,
          actionCount: actionableFindings.length,
        },
      },
    } satisfies AdapterExecutionResult;
  }

  const hasFailures = results.some((r) => r.exitCode !== 0);
  if (activeApprovedRun && issueId && !hasFailures) {
    await updateIssueStatus(ctx, issueId, "done", `Janitor approved cleanup completed.\n\n- Approval: \`${approvalId}\`\n- Active report: \`${reportPath}\``);
  }
  const summaryLines = [
    `Janitor audit complete. Ran ${results.length} module(s) on \`${cwd}\`.`,
    `Report saved to \`${reportPath}\`.`,
    hasFailures
      ? `⚠ ${results.filter((r) => r.exitCode !== 0).length} module(s) reported errors — see report for details.`
      : `✓ All modules completed without errors.`,
    effectiveDryRun ? `Mode: dry-run. No files were modified.` : `Mode: active. Changes may have been applied.`,
    prompt ? `Original task: ${redactJanitorText(prompt).slice(0, 1_000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    exitCode: hasFailures ? 1 : 0,
    signal: null,
    timedOut: false,
    summary: summaryLines,
  } satisfies AdapterExecutionResult;
}
