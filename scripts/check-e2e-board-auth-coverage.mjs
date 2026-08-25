#!/usr/bin/env node
// PAP-1975 removed local_trusted's implicit board grant with no session
// replacement for it (direction B — see
// doc/plans/2026-08-25-local-trusted-board-access-gap.md). Every e2e spec
// that creates a company therefore needs an explicit board credential; a
// spec that imports plain `test`/`expect` from "@playwright/test" instead of
// "./fixtures/board-auth.js" silently falls back to an anonymous actor and
// 403s the moment it tries to create one — exactly the class of bug this PR
// spent most of its time finding and fixing one file at a time. This check
// makes that mechanical so it can't recur silently.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Matches a POST whose literal path is exactly the company-creation
// endpoint (`/api/companies` or `/companies`, no trailing sub-path) inside a
// template literal or string — the one call every board-gated spec makes
// first. Deliberately does NOT try to match every board-gated route; this
// endpoint is the one universal tripwire every affected file in this PR
// actually hit.
export const COMPANY_CREATE_POST_PATTERN = /\.post\(\s*[`"'](?:\/api)?\/companies[`"']/;

// A file opts out with this marker (own line or trailing) when it builds
// its own authenticated request context manually instead of importing the
// board-auth test wrapper (see tests/e2e/pipelines-tutorial-flow.spec.ts's
// pattern before it was migrated to the wrapper, kept here for any future
// spec that has a legitimate reason to do the same).
export const ALLOW_MARKER = "board-auth-coverage-check: manual-credential";

export const BOARD_AUTH_IMPORT_PATTERN = /from\s+["']\.\/fixtures\/board-auth(?:\.js)?["']/;

export function checkSpecSource(relativePath, source) {
  if (!COMPANY_CREATE_POST_PATTERN.test(source)) return null;
  if (BOARD_AUTH_IMPORT_PATTERN.test(source)) return null;
  if (source.includes(ALLOW_MARKER)) return null;
  return {
    relativePath,
    message:
      `${relativePath} POSTs to the company-creation endpoint but does not import ` +
      `test/expect from "./fixtures/board-auth.js" — it will 403 as an anonymous ` +
      `local_trusted actor (PAP-1975). Either import from "./fixtures/board-auth.js", ` +
      `or if this spec authenticates its own request context manually, add a ` +
      `"${ALLOW_MARKER}" comment explaining why.`,
  };
}

export function collectE2eSpecFiles(e2eDir) {
  return readdirSync(e2eDir)
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => path.join(e2eDir, name));
}

export function runCheck({ repoRoot }) {
  const e2eDir = path.join(repoRoot, "tests", "e2e");
  const files = collectE2eSpecFiles(e2eDir);
  const offenses = [];

  for (const filePath of files) {
    const relativePath = path.relative(repoRoot, filePath);
    const source = readFileSync(filePath, "utf8");
    const offense = checkSpecSource(relativePath, source);
    if (offense) offenses.push(offense);
  }

  if (offenses.length > 0) {
    console.error("ERROR: e2e specs found that create a company without a board credential:\n");
    for (const offense of offenses) {
      console.error(`  ${offense.message}\n`);
    }
    return 1;
  }

  console.log(`  ✓  All ${files.length} e2e specs that create a company import a board credential.`);
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = process.cwd();
  process.exit(runCheck({ repoRoot }));
}
