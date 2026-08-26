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
// actually hit. Allows an optional leading `${...}` interpolation (specs
// that build their own APIRequestContext commonly prefix a `${BASE_URL}`)
// or a bare http(s) origin before the path.
export const COMPANY_CREATE_POST_PATTERN =
  /\.post\(\s*[`"'](?:\$\{[^}]*\}|https?:\/\/[^`"'/]*)?(?:\/api)?\/companies[`"']/;

// A file opts out with this marker (own line or trailing) when it builds
// its own authenticated request context manually instead of importing the
// board-auth test wrapper (see tests/e2e/pipelines-tutorial-flow.spec.ts's
// pattern before it was migrated to the wrapper, kept here for any future
// spec that has a legitimate reason to do the same).
export const ALLOW_MARKER = "board-auth-coverage-check: manual-credential";

export const BOARD_AUTH_IMPORT_PATTERN = /from\s+["']\.\/fixtures\/board-auth(?:\.js)?["']/;

// Regression: an independent review found that importing the board-auth
// fixture is necessary but NOT sufficient. The fixture only overrides the
// `context` and injected `request` fixtures — a spec that ALSO imports the
// raw `request` export from "@playwright/test" to build its own standalone
// `APIRequestContext` (e.g. `pwRequest.newContext({ baseURL })`) is not
// covered by the fixture at all for that context; it needs its own
// `extraHTTPHeaders`/Authorization header, attached manually. Three real
// specs already do this correctly (signoff-policy, sidebar-takeover,
// pipelines-tutorial-flow) — this only requires *some* evidence of a
// manually-attached credential anywhere in the file, not that it's on the
// exact right call, so it stays a cheap tripwire rather than a full parse.
export const RAW_PLAYWRIGHT_REQUEST_IMPORT_PATTERN =
  /import\s*\{[^}]*\brequest\b[^}]*\}\s*from\s*["']@playwright\/test["']/;
export const MANUAL_CREDENTIAL_HEADER_EVIDENCE_PATTERN = /extraHTTPHeaders|Authorization/;

// Specs run through a dedicated, non-default Playwright config that isn't
// wired into any package.json script or CI workflow (confirmed via repo-wide
// grep 2026-08-25) — no `globalSetup` provisions a board credential for
// them, they expect an operator-started server, and nothing today actually
// runs them. `multi-user.spec.ts` (tests/e2e/playwright-multiuser.config.ts)
// genuinely still 403s in local_trusted mode and is NOT fixed by this PR —
// this is a real, separate, pre-existing gap (present since PAP-1975 itself,
// not introduced here), tracked as its own follow-up rather than absorbed
// into this PR's scope or silently marked "manual-credential" when it isn't
// one. Excluded here so this check's own job — catching specs that WILL run
// through the covered harness — isn't blocked by a file that can't use it.
const NOT_WIRED_INTO_ANY_HARNESS = new Set(["multi-user.spec.ts"]);

export function checkSpecSource(relativePath, source) {
  if (!COMPANY_CREATE_POST_PATTERN.test(source)) return null;
  if (source.includes(ALLOW_MARKER)) return null;

  const importsFixture = BOARD_AUTH_IMPORT_PATTERN.test(source);
  const buildsRawContext = RAW_PLAYWRIGHT_REQUEST_IMPORT_PATTERN.test(source);
  const hasManualCredentialEvidence = MANUAL_CREDENTIAL_HEADER_EVIDENCE_PATTERN.test(source);

  if (buildsRawContext && !hasManualCredentialEvidence) {
    return {
      relativePath,
      message:
        `${relativePath} imports the raw "request" export from "@playwright/test" to build its ` +
        `own APIRequestContext, but has no extraHTTPHeaders/Authorization evidence anywhere in ` +
        `the file — the board-auth fixture does NOT cover a manually-built context, only ` +
        `\`context\`/the injected \`request\` fixture. Attach a board credential's Authorization ` +
        `header when constructing that context.`,
    };
  }

  if (importsFixture || buildsRawContext) return null;

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
    .filter((name) => name.endsWith(".spec.ts") && !NOT_WIRED_INTO_ANY_HARNESS.has(name))
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
