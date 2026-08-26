import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression coverage for the fail-closed guard in board-key-bootstrap.ts —
 * proves the e2e-only credential-provisioning hook refuses to run outside
 * the e2e context, so it can never become a general-purpose way to mint
 * board authority. Run via: npx tsx --test tests/e2e/board-key-bootstrap.guard.test.ts
 */

test("provisionE2eBoardCredential refuses to run when PAPERCLIP_INSTANCE_ID is not playwright-e2e", async () => {
  const original = process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PAPERCLIP_INSTANCE_ID = "some-real-production-instance";
  try {
    const { provisionE2eBoardCredential } = await import("./board-key-bootstrap.js");
    await assert.rejects(
      () => provisionE2eBoardCredential(),
      /refusing to run outside the e2e context/,
    );
  } finally {
    if (original === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = original;
  }
});

test("provisionE2eBoardCredential refuses to run when PAPERCLIP_INSTANCE_ID is unset", async () => {
  const original = process.env.PAPERCLIP_INSTANCE_ID;
  delete process.env.PAPERCLIP_INSTANCE_ID;
  try {
    const { provisionE2eBoardCredential } = await import("./board-key-bootstrap.js");
    await assert.rejects(
      () => provisionE2eBoardCredential(),
      /refusing to run outside the e2e context/,
    );
  } finally {
    if (original !== undefined) process.env.PAPERCLIP_INSTANCE_ID = original;
  }
});

test("revokeE2eBoardCredential refuses to run outside the e2e context", async () => {
  const original = process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PAPERCLIP_INSTANCE_ID = "not-e2e";
  try {
    const { revokeE2eBoardCredential } = await import("./board-key-bootstrap.js");
    await assert.rejects(
      () => revokeE2eBoardCredential(),
      /refusing to run outside the e2e context/,
    );
  } finally {
    if (original === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = original;
  }
});

/**
 * Regression coverage for assertConnectedToThisRunsIsolatedDatabase — the
 * second, independent guard added after an adversarial review found that
 * assertE2eContext() alone (above) only checks PAPERCLIP_INSTANCE_ID, never
 * WHICH database provisionE2eBoardCredential is about to write an
 * instance-admin credential into. A stale on-disk config (a real scenario:
 * see the comment on assertConnectedToThisRunsIsolatedDatabase in
 * board-key-bootstrap.ts) could otherwise point this at a real instance's
 * database. No real Postgres connection needed — `sql` is just a tagged
 * template function here, so a fake one returning canned rows is enough to
 * exercise the comparison logic itself.
 */
function fakeSql(dataDirectory: string | null) {
  return (async () => [{ data_directory: dataDirectory }]) as unknown as Parameters<
    typeof import("./board-key-bootstrap.js").assertConnectedToThisRunsIsolatedDatabase
  >[0];
}

test("assertConnectedToThisRunsIsolatedDatabase refuses when the data directory is outside PAPERCLIP_HOME", async () => {
  const original = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = "/tmp/this-runs-own-home";
  try {
    const { assertConnectedToThisRunsIsolatedDatabase } = await import("./board-key-bootstrap.js");
    await assert.rejects(
      () => assertConnectedToThisRunsIsolatedDatabase(fakeSql("/var/lib/postgresql/16/main")),
      /does not resolve under this run's PAPERCLIP_HOME/,
    );
  } finally {
    if (original === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = original;
  }
});

test("assertConnectedToThisRunsIsolatedDatabase refuses when the data directory is unreadable", async () => {
  const original = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = "/tmp/this-runs-own-home";
  try {
    const { assertConnectedToThisRunsIsolatedDatabase } = await import("./board-key-bootstrap.js");
    await assert.rejects(
      () => assertConnectedToThisRunsIsolatedDatabase(fakeSql(null)),
      /does not resolve under this run's PAPERCLIP_HOME/,
    );
  } finally {
    if (original === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = original;
  }
});

test("assertConnectedToThisRunsIsolatedDatabase refuses when PAPERCLIP_HOME is unset", async () => {
  const original = process.env.PAPERCLIP_HOME;
  delete process.env.PAPERCLIP_HOME;
  try {
    const { assertConnectedToThisRunsIsolatedDatabase } = await import("./board-key-bootstrap.js");
    await assert.rejects(
      () => assertConnectedToThisRunsIsolatedDatabase(fakeSql("/anything")),
      /PAPERCLIP_HOME is not set/,
    );
  } finally {
    if (original !== undefined) process.env.PAPERCLIP_HOME = original;
  }
});

test("assertConnectedToThisRunsIsolatedDatabase accepts a data directory genuinely under PAPERCLIP_HOME", async () => {
  const original = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = "/tmp/this-runs-own-home";
  try {
    const { assertConnectedToThisRunsIsolatedDatabase } = await import("./board-key-bootstrap.js");
    await assert.doesNotReject(() =>
      assertConnectedToThisRunsIsolatedDatabase(fakeSql("/tmp/this-runs-own-home/instances/playwright-e2e/db")),
    );
  } finally {
    if (original === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = original;
  }
});

// Regression: an independent review found this exact boundary case was
// completely untested — mutation-tested the production code by dropping the
// `${sep}` from the `startsWith` check (board-key-bootstrap.ts) and by
// swapping it for a naive `.includes()`, and both weakened versions still
// passed the suite as it stood before this test existed. Both are real,
// live-reproducible false negatives: `/tmp/paperclip-e2e-home-1` is a
// string-prefix of `/tmp/paperclip-e2e-home-12/db`, a real, plausible
// sibling temp-dir collision (mkdtempSync's own naming scheme), but
// `home-12` is NOT a subdirectory of `home-1` — accepting it would defeat
// the entire guard for exactly the class of collision it exists to catch.
test("assertConnectedToThisRunsIsolatedDatabase refuses a sibling directory that merely shares a string prefix", async () => {
  const original = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-e2e-home-1";
  try {
    const { assertConnectedToThisRunsIsolatedDatabase } = await import("./board-key-bootstrap.js");
    await assert.rejects(
      () => assertConnectedToThisRunsIsolatedDatabase(fakeSql("/tmp/paperclip-e2e-home-12/instances/playwright-e2e/db")),
      /does not resolve under this run's PAPERCLIP_HOME/,
    );
  } finally {
    if (original === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = original;
  }
});
