import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOW_MARKER,
  BOARD_AUTH_IMPORT_PATTERN,
  COMPANY_CREATE_POST_PATTERN,
  checkSpecSource,
  runCheck,
} from "./check-e2e-board-auth-coverage.mjs";

test("COMPANY_CREATE_POST_PATTERN matches the company-creation endpoint", () => {
  assert.ok(COMPANY_CREATE_POST_PATTERN.test('await page.request.post("/api/companies", {'));
  assert.ok(COMPANY_CREATE_POST_PATTERN.test("await request.post(`/api/companies`, {"));
  assert.ok(COMPANY_CREATE_POST_PATTERN.test("await board.post('/companies', {"));
});

test("COMPANY_CREATE_POST_PATTERN ignores company sub-resource POSTs", () => {
  assert.ok(!COMPANY_CREATE_POST_PATTERN.test('await request.post(`/api/companies/${companyId}/agents`, {'));
  assert.ok(!COMPANY_CREATE_POST_PATTERN.test('await request.get("/api/companies")'));
});

test("BOARD_AUTH_IMPORT_PATTERN matches both quote styles and the .js suffix", () => {
  assert.ok(BOARD_AUTH_IMPORT_PATTERN.test('import { test, expect } from "./fixtures/board-auth.js";'));
  assert.ok(BOARD_AUTH_IMPORT_PATTERN.test("import { test, expect } from './fixtures/board-auth';"));
});

test("checkSpecSource flags a company-creating spec with a plain @playwright/test import", () => {
  const source = [
    'import { expect, test } from "@playwright/test";',
    'test("x", async ({ request }) => {',
    '  await request.post("/api/companies", { data: {} });',
    "});",
  ].join("\n");
  const offense = checkSpecSource("tests/e2e/example.spec.ts", source);
  assert.ok(offense);
  assert.match(offense.message, /example\.spec\.ts/);
});

test("checkSpecSource passes a company-creating spec that imports the board-auth wrapper", () => {
  const source = [
    'import { test, expect } from "./fixtures/board-auth.js";',
    'test("x", async ({ request }) => {',
    '  await request.post("/api/companies", { data: {} });',
    "});",
  ].join("\n");
  assert.equal(checkSpecSource("tests/e2e/example.spec.ts", source), null);
});

test("checkSpecSource passes a company-creating spec with the manual opt-out marker", () => {
  const source = [
    'import { expect, test } from "@playwright/test";',
    `// ${ALLOW_MARKER}: builds its own authenticated APIRequestContext below.`,
    'test("x", async () => {',
    '  await board.post("/api/companies", { data: {} });',
    "});",
  ].join("\n");
  assert.equal(checkSpecSource("tests/e2e/example.spec.ts", source), null);
});

test("checkSpecSource ignores specs that never create a company", () => {
  const source = [
    'import { expect, test } from "@playwright/test";',
    'test("x", async ({ page }) => {',
    '  await page.goto("/settings");',
    "});",
  ].join("\n");
  assert.equal(checkSpecSource("tests/e2e/example.spec.ts", source), null);
});

test("runCheck scans a real directory and fails on an unguarded spec", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "board-auth-coverage-"));
  const e2eDir = path.join(repoRoot, "tests", "e2e");
  mkdirSync(e2eDir, { recursive: true });
  writeFileSync(
    path.join(e2eDir, "unguarded.spec.ts"),
    [
      'import { expect, test } from "@playwright/test";',
      'test("x", async ({ request }) => {',
      '  await request.post("/api/companies", { data: {} });',
      "});",
    ].join("\n"),
  );

  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  let exitCode;
  try {
    exitCode = runCheck({ repoRoot });
  } finally {
    console.error = originalError;
    console.log = originalLog;
    rmSync(repoRoot, { recursive: true, force: true });
  }
  assert.equal(exitCode, 1);
});

test("runCheck passes when every company-creating spec is guarded", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "board-auth-coverage-"));
  const e2eDir = path.join(repoRoot, "tests", "e2e");
  mkdirSync(e2eDir, { recursive: true });
  writeFileSync(
    path.join(e2eDir, "guarded.spec.ts"),
    [
      'import { test, expect } from "./fixtures/board-auth.js";',
      'test("x", async ({ request }) => {',
      '  await request.post("/api/companies", { data: {} });',
      "});",
    ].join("\n"),
  );

  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  let exitCode;
  try {
    exitCode = runCheck({ repoRoot });
  } finally {
    console.error = originalError;
    console.log = originalLog;
    rmSync(repoRoot, { recursive: true, force: true });
  }
  assert.equal(exitCode, 0);
});
