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
