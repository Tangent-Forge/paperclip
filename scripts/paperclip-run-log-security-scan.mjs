#!/usr/bin/env node
/**
 * PAP-1758 D4 self-heal: scan retained run-logs for credential-shaped / secret-adjacent
 * material, quarantine hits, and optionally open/update a Paperclip alert issue.
 *
 * Paths/counts only in alerts. Never prints secret values.
 *
 * Usage:
 *   node scripts/paperclip-run-log-security-scan.mjs --dry-run
 *   node scripts/paperclip-run-log-security-scan.mjs --apply
 *   node scripts/paperclip-run-log-security-scan.mjs --apply --alert
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployRoot = path.resolve(__dirname, "..");
const serverRoot = path.join(deployRoot, "server");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has("--apply");
const alert = args.has("--alert");
const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100/api").replace(/\/$/, "");
const companyId = process.env.PAPERCLIP_COMPANY_ID || "b7361769-54ba-4778-8d07-9e2851fedd74";
const parentIssueId = process.env.PAPERCLIP_SECURITY_PARENT_ISSUE_ID || ""; // optional
const securityReviewerAgentId =
  process.env.PAPERCLIP_SECURITY_REVIEWER_AGENT_ID || "ee38711e-c3fd-4d69-84e9-00802ee348b6";

function findTsxLoader() {
  const direct = path.join(serverRoot, "node_modules/tsx/dist/loader.mjs");
  return direct;
}

async function runScanViaTsx() {
  const loader = findTsxLoader();
  const runner = `
import { scanAndQuarantineRunLogs, buildSecurityAlertIssueBody, RUN_LOG_SECURITY_ALERT_MARKER } from "./src/services/run-log-security-scanner.ts";
const dryRun = process.env.SCAN_DRY_RUN === "1";
const result = await scanAndQuarantineRunLogs({ dryRun });
const body = buildSecurityAlertIssueBody(result);
process.stdout.write(JSON.stringify({ result, body, marker: RUN_LOG_SECURITY_ALERT_MARKER }) + "\\n");
`;
  const tmp = path.join(serverRoot, `.tf-scan-runner-${process.pid}.mts`);
  await fs.writeFile(tmp, runner, "utf8");
  try {
    const env = {
      ...process.env,
      SCAN_DRY_RUN: dryRun ? "1" : "0",
    };
    const proc = spawnSync(
      process.execPath,
      ["--import", loader, tmp],
      { cwd: serverRoot, env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
    if (proc.status !== 0) {
      process.stderr.write(proc.stderr || proc.stdout || "scan failed\n");
      process.exit(proc.status ?? 1);
    }
    const line = (proc.stdout || "").trim().split("\n").filter(Boolean).at(-1);
    return JSON.parse(line);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

async function api(pathname, init = {}) {
  const res = await fetch(`${apiBase}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(`API ${init.method || "GET"} ${pathname} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return data;
}

async function maybeAlert(payload) {
  if (!alert) return { alerted: false, reason: "alert_flag_off" };
  if (payload.result.hitFiles <= 0) return { alerted: false, reason: "no_hits" };

  // Prefer commenting on an open auto-issue with marker; else create one.
  const issues = await api(
    `/companies/${companyId}/issues?status=todo,in_progress,blocked,backlog&limit=200&orderBy=created`,
  );
  const list = Array.isArray(issues) ? issues : issues?.items || [];
  const existing = list.find(
    (i) =>
      typeof i?.title === "string" &&
      i.title.includes("[auto] Retained run-log security hit") &&
      typeof i?.description === "string" &&
      i.description.includes(payload.marker),
  );

  if (existing?.id) {
    const comment = await api(`/issues/${existing.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: payload.body }),
    });
    return {
      alerted: true,
      mode: "comment",
      issueId: existing.id,
      identifier: existing.identifier || null,
      commentId: comment?.id || null,
    };
  }

  const created = await api(`/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "[auto] Retained run-log security hit",
      description: payload.body,
      status: "todo",
      priority: "high",
      ...(parentIssueId ? { parentId: parentIssueId } : {}),
      // assignee best-effort; ignore if id wrong
      assigneeAgentId: securityReviewerAgentId || null,
    }),
  });
  return {
    alerted: true,
    mode: "create",
    issueId: created?.id || null,
    identifier: created?.identifier || null,
  };
}

const payload = await runScanViaTsx();
let alertResult = { alerted: false, reason: "skipped" };
try {
  alertResult = await maybeAlert(payload);
} catch (err) {
  alertResult = {
    alerted: false,
    reason: "alert_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

// Emit paths/counts only
const out = {
  dryRun,
  scannedFiles: payload.result.scannedFiles,
  hitFiles: payload.result.hitFiles,
  movedFiles: payload.result.movedFiles,
  bytesMoved: payload.result.bytesMoved,
  fingerprint: payload.result.fingerprint,
  quarantineDir: payload.result.quarantineDir,
  errors: payload.result.errors.length,
  hits: payload.result.hits.map((h) => ({
    relPath: h.relPath,
    patternHits: h.patternHits,
    sizeBytes: h.sizeBytes,
  })),
  alert: alertResult,
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(payload.result.errors.length > 0 ? 2 : 0);
