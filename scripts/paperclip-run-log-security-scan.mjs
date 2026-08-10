#!/usr/bin/env node
/**
 * CLI entrypoint for the PAP-1758 D4 retained-run-log credential scan.
 *
 * Background: `.tf-deploy/paperclip-run-log-security-scan.sh` has shipped since
 * ~2026-07-29 invoking `scripts/paperclip-run-log-security-scan.mjs`, but that
 * file was never committed at that path. The systemd timer therefore died every
 * 15 minutes with MODULE_NOT_FOUND and the scan has never run. The scan logic
 * itself has always existed and is tested
 * (server/src/services/run-log-security-scanner.ts + its __tests__), it simply
 * had no caller outside the test suite. This file is that missing caller.
 *
 * Usage:
 *   paperclip-run-log-security-scan.mjs [--apply|--dry-run] [--alert|--no-alert]
 *
 * Defaults are deliberately SAFE: without --apply this only reports. --apply
 * moves matching run logs into the instance security-quarantine directory.
 *
 * Exit codes:
 *   0  scan completed, no credential-shaped hits
 *   1  scan failed to run
 *   2  scan completed and FOUND hits (actionable; distinct from failure)
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/**
 * Resolve tsx's programmatic ESM register API. tsx >=4 rejects the old
 * `--loader`-style dist/loader.mjs when registered via node:module.register,
 * so we must go through `tsx/esm/api`. Resolution is attempted from server/
 * first (where the runtime deps live) and then the repo root.
 */
async function loadTsxRegister() {
  for (const base of [path.join(repoRoot, "server"), repoRoot]) {
    try {
      const require = createRequire(path.join(base, "noop.js"));
      const api = require.resolve("tsx/esm/api");
      return (await import(pathToFileURL(api).href)).register;
    } catch {
      /* try next base */
    }
  }
  return null;
}

const args = new Set(process.argv.slice(2));
// Fail safe: only an explicit --apply enables quarantine moves.
const dryRun = !args.has("--apply");
const alert = args.has("--alert") && !args.has("--no-alert");

async function main() {
  const register = await loadTsxRegister();
  if (!register) {
    console.error(
      "[run-log-security-scan] tsx/esm/api not resolvable; run pnpm install in server/",
    );
    return 1;
  }
  register();

  const mod = await import(
    pathToFileURL(
      path.join(repoRoot, "server", "src", "services", "run-log-security-scanner.ts"),
    ).href
  );

  const result = await mod.scanAndQuarantineRunLogs({ dryRun });

  // Never print file contents — only paths, counts and sizes. The whole point
  // of this scan is that these files may contain credential material.
  console.log(
    JSON.stringify(
      {
        mode: dryRun ? "report-only" : "apply",
        scannedFiles: result.scannedFiles,
        hitFiles: result.hitFiles,
        movedFiles: result.movedFiles,
        bytesMoved: result.bytesMoved,
        quarantineDir: result.quarantineDir,
        fingerprint: result.fingerprint,
        errorCount: result.errors.length,
        hits: result.hits,
      },
      null,
      2,
    ),
  );

  if (alert && result.hitFiles > 0) {
    console.log(`\n--- ${mod.RUN_LOG_SECURITY_ALERT_MARKER} ---`);
    console.log(mod.buildSecurityAlertIssueBody(result));
  }

  if (result.errors.length > 0) {
    console.error(`[run-log-security-scan] ${result.errors.length} file error(s)`);
    for (const e of result.errors.slice(0, 20)) {
      console.error(`  ${e.relPath}: ${e.message}`);
    }
  }

  return result.hitFiles > 0 ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[run-log-security-scan] failed:", err?.stack ?? err);
    process.exit(1);
  },
);
