/**
 * E2E-only board credential bootstrap.
 *
 * PAP-1975 removed the `local_trusted` deployment mode's implicit
 * `local-board`/instance-admin grant for unauthenticated loopback requests
 * (see server/src/middleware/auth.ts). This suite's own bootstrap flow
 * (company creation during onboarding, the experimental-flags toggle used by
 * several specs) relied on that implicit grant and started failing with
 * "Board access required" once it was removed.
 *
 * This file provisions a narrowly-scoped, e2e-only board API key directly
 * against the throwaway embedded-Postgres instance this suite already
 * spins up per run (see playwright.config.ts's `webServer` block), using
 * the exact same schema/token shape as
 * server/src/services/board-auth.ts#createNamedBoardApiKey and
 * server/src/board-claim.ts#claimBoardOwnership.
 *
 * Deliberately does NOT import server/src/services/board-auth.ts or any
 * other application code — this connects to Postgres directly and issues
 * plain parameterized SQL against the known schema, mirroring the existing
 * precedent in cli/src/commands/auth-bootstrap-ceo.ts (which does the same
 * direct-DB-connection technique for its own bootstrap-invite flow, rather
 * than reaching into server internals).
 *
 * Does NOT touch server/src/board-claim.ts or server/src/middleware/auth.ts.
 * Does NOT change local_trusted's runtime semantics for any real request —
 * this only ever runs against this suite's own disposable database, gated
 * by PAPERCLIP_INSTANCE_ID below.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import postgres from "postgres";

const E2E_INSTANCE_ID = "playwright-e2e";
const DEFAULT_EMBEDDED_POSTGRES_PORT = 54329;
// Bounded lifetime: long enough to cover a full serial e2e run (workers: 1,
// specs run one after another), short enough that a leaked token from a
// killed/interrupted run is worthless within the hour. Explicit teardown
// (see global-teardown.ts) deletes it well before this regardless.
const KEY_TTL_MS = 60 * 60 * 1000;

export interface E2eBoardCredential {
  userId: string;
  keyId: string;
  token: string;
}

function assertE2eContext(): void {
  if (process.env.PAPERCLIP_INSTANCE_ID !== E2E_INSTANCE_ID) {
    throw new Error(
      "board-key-bootstrap: refusing to run outside the e2e context " +
        `(PAPERCLIP_INSTANCE_ID must be "${E2E_INSTANCE_ID}"). ` +
        "This must never run against a real instance.",
    );
  }
}

function resolveEmbeddedPostgresPort(): number {
  const configPath = process.env.PAPERCLIP_CONFIG;
  if (!configPath || !existsSync(configPath)) return DEFAULT_EMBEDDED_POSTGRES_PORT;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      database?: { embeddedPostgresPort?: number };
    };
    return raw.database?.embeddedPostgresPort ?? DEFAULT_EMBEDDED_POSTGRES_PORT;
  } catch {
    // Same fallback cli/src/commands/auth-bootstrap-ceo.ts uses when config
    // parsing fails — the default embedded-postgres port.
    return DEFAULT_EMBEDDED_POSTGRES_PORT;
  }
}

function connect() {
  const port = resolveEmbeddedPostgresPort();
  return postgres(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`, {
    max: 1,
    onnotice: () => {},
  });
}

/**
 * `resolveEmbeddedPostgresPort()` falls back to the same default port
 * (54329) that a real, non-e2e instance also defaults to, and
 * `assertE2eContext()` above only checks `PAPERCLIP_INSTANCE_ID` — neither
 * one actually confirms *which* database this is about to write an
 * instance-admin credential into. If a real instance's embedded Postgres
 * happens to be reachable on the resolved port (a real scenario: the
 * server's own port-collision fallback in server/src/index.ts corrects its
 * *in-memory* config on a collision but only persists that correction back
 * to disk when `PAPERCLIP_IN_WORKTREE=true`, which this harness never
 * sets — so the on-disk config this file reads can name the wrong,
 * real-instance port), this would silently mint a live instance-admin board
 * API key in that real database.
 *
 * Mirrors the exact same defense server/src/index.ts already uses before
 * touching a reachable Postgres it didn't start: confirm its
 * `data_directory` resolves under *this run's own* `PAPERCLIP_HOME` before
 * writing anything. Fails closed — a missing/mismatched data directory
 * aborts provisioning rather than falling through to a guess.
 */
export async function assertConnectedToThisRunsIsolatedDatabase(sql: ReturnType<typeof postgres>): Promise<void> {
  const home = process.env.PAPERCLIP_HOME;
  if (!home) {
    throw new Error("board-key-bootstrap: PAPERCLIP_HOME is not set; refusing to provision a board credential.");
  }
  let dataDirectory: string | null = null;
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    dataDirectory = rows[0]?.data_directory ?? null;
  } catch {
    dataDirectory = null;
  }
  const homeResolved = realpathSyncOrSelf(home);
  const dataDirResolved = dataDirectory ? realpathSyncOrSelf(dataDirectory) : null;
  if (!dataDirResolved || !dataDirResolved.startsWith(`${homeResolved}${sep}`)) {
    throw new Error(
      "board-key-bootstrap: refusing to provision a board credential — the reachable Postgres's " +
        `data_directory (${dataDirectory ?? "<unreadable>"}) does not resolve under this run's ` +
        `PAPERCLIP_HOME (${home}). This is not this e2e run's own isolated database; it may be a ` +
        "real instance sharing the same port. Aborting rather than guessing.",
    );
  }
}

function realpathSyncOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function credentialFilePath(): string {
  const home = process.env.PAPERCLIP_HOME;
  if (!home) {
    throw new Error("board-key-bootstrap: PAPERCLIP_HOME is not set");
  }
  // PAPERCLIP_HOME is a per-run mkdtempSync() directory outside the repo
  // (see playwright.config.ts) — never inside tests/e2e/test-results,
  // playwright-report, or any traced/screenshotted path, and never
  // git-tracked.
  return `${home}/e2e-board-credential.json`;
}

export async function provisionE2eBoardCredential(): Promise<E2eBoardCredential> {
  assertE2eContext();
  const sql = connect();
  try {
    await assertConnectedToThisRunsIsolatedDatabase(sql);
    const userId = `e2e-board-${randomBytes(6).toString("hex")}`;
    const now = new Date();

    await sql`
      insert into "user" (id, name, email, email_verified, created_at, updated_at)
      values (${userId}, ${"E2E Playwright (test-only)"}, ${`${userId}@e2e.invalid`}, true, ${now}, ${now})
    `;

    // Company creation and the experimental-settings toggle both require
    // isInstanceAdmin (see server/src/routes/companies.ts and
    // server/src/routes/instance-settings.ts, assertCanManageInstanceSettings)
    // now that `local_implicit` no longer exists — this is the actual scope
    // those two endpoints require, not a broader grant chosen for convenience.
    await sql`
      insert into instance_user_roles (user_id, role)
      values (${userId}, ${"instance_admin"})
    `;

    const token = `pcp_board_${randomBytes(24).toString("hex")}`;
    const keyHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + KEY_TTL_MS);

    const [key] = await sql<{ id: string }[]>`
      insert into board_api_keys (user_id, name, key_hash, expires_at)
      values (${userId}, ${"e2e-playwright (auto-provisioned, auto-revoked)"}, ${keyHash}, ${expiresAt})
      returning id
    `;

    const credential: E2eBoardCredential = { userId, keyId: key.id, token };
    // Never logged/printed — written only to a file outside the repo, with
    // owner-only permissions, read back by the fixture/teardown by path.
    writeFileSync(credentialFilePath(), JSON.stringify({ userId, keyId: key.id, token }), {
      mode: 0o600,
    });
    return credential;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function readE2eBoardCredential(): E2eBoardCredential | null {
  const path = credentialFilePath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as E2eBoardCredential;
}

export async function revokeE2eBoardCredential(): Promise<void> {
  assertE2eContext();
  const path = credentialFilePath();
  const credential = readE2eBoardCredential();
  if (!credential) return;

  const sql = connect();
  try {
    // Same defense as provisioning, and just as necessary here: this issues
    // real DELETEs keyed only on a userId string. If port resolution ever
    // diverges between provisioning and teardown (a stale on-disk config
    // changing mid-run, a real instance answering on the resolved port),
    // this would otherwise delete rows in a database this run doesn't own.
    await assertConnectedToThisRunsIsolatedDatabase(sql);
    // Explicit deletes in FK-safe order rather than relying solely on
    // board_api_keys' ON DELETE CASCADE from "user" — instance_user_roles
    // has no FK to "user" at all, so it needs its own explicit delete.
    await sql`delete from board_api_keys where user_id = ${credential.userId}`;
    await sql`delete from instance_user_roles where user_id = ${credential.userId}`;
    await sql`delete from "user" where id = ${credential.userId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (existsSync(path)) unlinkSync(path);
}
