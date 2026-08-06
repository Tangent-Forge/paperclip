import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** Patterns used only for hit detection (counts/paths). Never emit match text.
 * Include escaped-JSON forms because run-log lines wrap chunk text inside ndjson.
 */
const CREDENTIAL_SHAPE_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgho_[A-Za-z0-9]{20,}\b/,
  /\bghu_[A-Za-z0-9]{20,}\b/,
  /\bghs_[A-Za-z0-9]{20,}\b/,
  /\bghr_[A-Za-z0-9]{20,}\b/,
  /\bAuthorization:\s*Bearer\s+\S+/i,
  /(?:\\?"type\\?"\s*:\s*\\?"secret_ref\\?"|type\\?"?\s*:\s*\\?"secret_ref)/,
  /adapterConfig\s*\\?"?\s*:/,
  /runtimeConfig\s*\\?"?\s*:/,
  /OPENAI_API_KEY\s*\\?"?\s*[:=]/i,
  /PAPERCLIP_API_KEY\s*\\?"?\s*[:=]/i,
];

export const RUN_LOG_SECURITY_ALERT_MARKER = "paperclip-run-log-security-scan";

export type RunLogScanHit = {
  absPath: string;
  relPath: string;
  patternHits: number;
  sizeBytes: number;
};

export type RunLogScanResult = {
  scannedFiles: number;
  hitFiles: number;
  movedFiles: number;
  bytesMoved: number;
  dryRun: boolean;
  quarantineDir: string | null;
  hits: Array<Pick<RunLogScanHit, "relPath" | "patternHits" | "sizeBytes">>;
  errors: Array<{ relPath: string; message: string }>;
  fingerprint: string;
};

export type RunLogScanOptions = {
  runLogsRoot?: string;
  quarantineRoot?: string;
  dryRun?: boolean;
  /** Only scan files modified at/after this time (ms epoch). */
  mtimeAfterMs?: number;
  /** Max files to scan (safety bound). */
  maxFiles?: number;
  now?: Date;
};

function defaultRunLogsRoot() {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
}

function defaultQuarantineRoot() {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "security-quarantine");
}

export function countCredentialShapeHits(text: string): number {
  let hits = 0;
  for (const re of CREDENTIAL_SHAPE_RES) {
    re.lastIndex = 0;
    if (re.test(text)) hits += 1;
  }
  return hits;
}

async function walkNdjsonFiles(root: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ndjson")) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

async function ensurePrivateDir(dir: string) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
}

export async function scanAndQuarantineRunLogs(opts: RunLogScanOptions = {}): Promise<RunLogScanResult> {
  const dryRun = opts.dryRun === true;
  const runLogsRoot = opts.runLogsRoot ?? defaultRunLogsRoot();
  const quarantineRoot = opts.quarantineRoot ?? defaultQuarantineRoot();
  const maxFiles = opts.maxFiles ?? 50_000;
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "").replace("Z", "Z");
  const batchDir = path.join(quarantineRoot, "auto", stamp);

  const files = await walkNdjsonFiles(runLogsRoot, maxFiles);
  const hits: RunLogScanHit[] = [];
  const errors: Array<{ relPath: string; message: string }> = [];
  let movedFiles = 0;
  let bytesMoved = 0;

  for (const absPath of files) {
    const relPath = path.relative(runLogsRoot, absPath);
    try {
      const st = await fs.stat(absPath);
      if (opts.mtimeAfterMs != null && st.mtimeMs < opts.mtimeAfterMs) continue;
      const text = await fs.readFile(absPath, "utf8");
      const patternHits = countCredentialShapeHits(text);
      if (patternHits <= 0) continue;
      hits.push({
        absPath,
        relPath,
        patternHits,
        sizeBytes: st.size,
      });
    } catch (err) {
      errors.push({
        relPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!dryRun && hits.length > 0) {
    await ensurePrivateDir(batchDir);
    for (const hit of hits) {
      try {
        const dest = path.join(batchDir, "run-logs", hit.relPath);
        await ensurePrivateDir(path.dirname(dest));
        await fs.rename(hit.absPath, dest);
        await fs.chmod(dest, 0o600).catch(() => undefined);
        movedFiles += 1;
        bytesMoved += hit.sizeBytes;
      } catch (err) {
        // Cross-device rename fallback
        try {
          const dest = path.join(batchDir, "run-logs", hit.relPath);
          await ensurePrivateDir(path.dirname(dest));
          await fs.copyFile(hit.absPath, dest);
          await fs.chmod(dest, 0o600).catch(() => undefined);
          await fs.unlink(hit.absPath);
          movedFiles += 1;
          bytesMoved += hit.sizeBytes;
        } catch (err2) {
          errors.push({
            relPath: hit.relPath,
            message: err2 instanceof Error ? err2.message : String(err2),
          });
        }
      }
    }
  }

  const hitSummary = hits.map((h) => ({
    relPath: h.relPath,
    patternHits: h.patternHits,
    sizeBytes: h.sizeBytes,
  }));
  const fingerprint = createHash("sha256")
    .update(
      hitSummary
        .map((h) => `${h.relPath}|${h.patternHits}|${h.sizeBytes}`)
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16);

  if (!dryRun && hits.length > 0) {
    const summaryPath = path.join(batchDir, "scan-summary.json");
    await fs.writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          marker: RUN_LOG_SECURITY_ALERT_MARKER,
          createdAt: now.toISOString(),
          dryRun,
          scannedFiles: files.length,
          hitFiles: hits.length,
          movedFiles,
          bytesMoved,
          fingerprint,
          hits: hitSummary,
          errors,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.chmod(summaryPath, 0o600).catch(() => undefined);
  }

  return {
    scannedFiles: files.length,
    hitFiles: hits.length,
    movedFiles: dryRun ? 0 : movedFiles,
    bytesMoved: dryRun ? 0 : bytesMoved,
    dryRun,
    quarantineDir: !dryRun && hits.length > 0 ? batchDir : null,
    hits: hitSummary,
    errors,
    fingerprint,
  };
}

export function buildSecurityAlertIssueBody(result: RunLogScanResult): string {
  const lines = [
    `Automated retained run-log security scan (${RUN_LOG_SECURITY_ALERT_MARKER}).`,
    "",
    "Paths/counts only. Do not paste secrets or keys into comments.",
    "Do not hand-edit runtime.env. Rotation, if required, is owner-gated via 1Password + tf-secrets only.",
    "",
    `- dryRun: ${result.dryRun}`,
    `- scannedFiles: ${result.scannedFiles}`,
    `- hitFiles: ${result.hitFiles}`,
    `- movedFiles: ${result.movedFiles}`,
    `- bytesMoved: ${result.bytesMoved}`,
    `- fingerprint: ${result.fingerprint}`,
    `- quarantineDir: ${result.quarantineDir ?? "(none)"}`,
    `- errors: ${result.errors.length}`,
    "",
    "Hit files (relative paths + pattern-hit counts only):",
  ];
  for (const hit of result.hits.slice(0, 50)) {
    lines.push(`- ${hit.relPath} (patternHits=${hit.patternHits}, bytes=${hit.sizeBytes})`);
  }
  if (result.hits.length > 50) {
    lines.push(`- … ${result.hits.length - 50} more`);
  }
  lines.push("");
  lines.push(
    "Self-heal action taken: credential-shaped retained logs were quarantined under data/security-quarantine/auto/ when apply mode ran.",
  );
  lines.push(
    "Follow-up: confirm write-path scrub still green; owner rotation only if live fingerprint overlap is proven.",
  );
  return lines.join("\n");
}
