import path from "node:path";
import fs from "node:fs/promises";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asBoolean, asNumber, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import { runJanitorModule, JANITOR_MODULES, type JanitorModuleId } from "./modules.js";

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
      lines.push("", "```", result.stdout.trim(), "```");
    }
    if (result.stderr.trim()) {
      lines.push("", "**Errors/Warnings:**", "```", result.stderr.trim(), "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config as Record<string, unknown>;
  const prompt = asString(ctx.context["prompt"] as unknown, "");

  const cwd = asString(config.cwd, process.cwd());
  const dryRun = asBoolean(config.dryRun, true);
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const reportDir = asString(config.reportDir, path.join(cwd, ".janitor", "reports"));
  const moduleIds = asJanitorModuleIds(config.modules);
  const approvalRequired = asBoolean(config.approvalRequired, true);

  const extraEnv: Record<string, string> = {
    JANITOR_DRY_RUN: dryRun ? "1" : "0",
    JANITOR_APPROVAL_REQUIRED: approvalRequired ? "1" : "0",
    JANITOR_REPORT_DIR: reportDir,
  };

  if (config.maxStorageAgeDays !== undefined) {
    extraEnv.JANITOR_MAX_AGE_DAYS = String(asNumber(config.maxStorageAgeDays, 90));
  }

  if (config.secretsPatterns !== undefined) {
    extraEnv.JANITOR_EXTRA_PATTERNS = (asStringArray(config.secretsPatterns) ?? []).join(",");
  }

  await fs.mkdir(reportDir, { recursive: true });

  const results = [];
  for (const moduleId of moduleIds) {
    const result = await runJanitorModule(moduleId, cwd, extraEnv, timeoutSec * 1000);
    results.push(result);
  }

  const report = buildReport(results, cwd, dryRun);
  const reportPath = path.join(reportDir, `audit-${Date.now()}.md`);
  await fs.writeFile(reportPath, report, "utf-8");

  const hasFailures = results.some((r) => r.exitCode !== 0);
  const summaryLines = [
    `Janitor audit complete. Ran ${results.length} module(s) on \`${cwd}\`.`,
    `Report saved to \`${reportPath}\`.`,
    hasFailures
      ? `⚠ ${results.filter((r) => r.exitCode !== 0).length} module(s) reported errors — see report for details.`
      : `✓ All modules completed without errors.`,
    dryRun ? `Mode: dry-run. No files were modified.` : `Mode: active. Changes may have been applied.`,
    prompt ? `Original task: ${prompt}` : "",
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
