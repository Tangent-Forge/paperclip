import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The Smoke Lab HTTP sidecar is spawned `detached` and `unref`'d, and any
// parent can be SIGKILLed, which delivers no signal to its children. A fixture
// that only exits when asked therefore outlives its parent and leaks for the
// lifetime of the host. These tests hold that line.

const stdioFixture = new URL("../mcp-fixtures/servers/stdio-fixture.mjs", import.meta.url).pathname;
const httpFixture = new URL("../mcp-fixtures/servers/http-fixture.mjs", import.meta.url).pathname;

// The watchdog polls for reparenting; a short interval keeps the suite quick.
const POLL_MS = 200;
const EXIT_TIMEOUT_MS = 10_000;

const cleanupDirs = [];
const strayPids = new Set();

test.after(() => {
  for (const pid of strayPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is the outcome these tests want anyway.
    }
  }
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-fixture-lifecycle-"));
  cleanupDirs.push(dir);
  return dir;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A process orphaned onto a parent that never wait()s stays in the table as
  // a zombie, and signal 0 still succeeds against it. It has exited, which is
  // all these tests assert, so read the real state where the kernel exposes it.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    if (state === "Z") return false;
  } catch {
    return false;
  }
  return true;
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${description}`);
}

/**
 * Spawns a stand-in parent that starts one fixture and then hangs, mirroring
 * how the harness and the Smoke Lab sidecar hold a fixture open. Returns both
 * pids so a test can kill the parent and watch the fixture.
 *
 * detached: true reproduces the Smoke Lab sidecar, which also gets stdio[0]
 * "ignore" -- meaning the fixture cannot fall back to noticing a closed stdin.
 *
 * The parent signals readiness only after the fixture has actually produced
 * output. Killing it any earlier proves nothing: the fixture would still be
 * starting up, and its first write to a now-broken stdout pipe would take it
 * down with EPIPE no matter how it handles parent death.
 */
async function startFixtureUnderParent(fixturePath, { detached }) {
  const dir = makeTempDir();
  const pidFile = path.join(dir, "child.pid");
  const readyFile = path.join(dir, "child.ready");
  const parentScript = path.join(dir, "parent.mjs");
  fs.writeFileSync(
    parentScript,
    [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      "const child = spawn(process.execPath, [process.argv[2]], {",
      '  env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },',
      `  stdio: ${detached ? '["ignore", "pipe", "pipe"]' : '["pipe", "pipe", "pipe"]'},`,
      `  detached: ${String(detached)},`,
      "});",
      detached ? "child.unref();" : "",
      "fs.writeFileSync(process.argv[3], String(child.pid));",
      // The http fixture announces itself; the stdio fixture answers a request.
      'child.stdout.once("data", () => fs.writeFileSync(process.argv[4], "ready"));',
      detached
        ? ""
        : 'child.stdin.write(JSON.stringify({ id: "1", method: "health" }) + "\\n");',
      "setInterval(() => {}, 1 << 30);",
    ].join("\n"),
  );

  const parent = spawn(process.execPath, [parentScript, fixturePath, pidFile, readyFile], {
    env: { ...process.env, MCP_FIXTURE_PARENT_POLL_MS: String(POLL_MS) },
    stdio: "ignore",
  });
  strayPids.add(parent.pid);

  await waitFor(
    () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0,
    EXIT_TIMEOUT_MS,
    "the fixture to report its pid",
  );
  const fixturePid = Number(fs.readFileSync(pidFile, "utf8").trim());
  strayPids.add(fixturePid);

  await waitFor(() => fs.existsSync(readyFile), EXIT_TIMEOUT_MS, "the fixture to start serving");
  assert.ok(isAlive(fixturePid), "fixture should be running before the parent is killed");
  return { parentPid: parent.pid, fixturePid };
}

test("http fixture exits when its detached parent is SIGKILLed", async () => {
  const { parentPid, fixturePid } = await startFixtureUnderParent(httpFixture, { detached: true });

  // SIGKILL delivers nothing to the child, and a detached child with stdio[0]
  // "ignore" has no stdin to notice either: only the watchdog can catch this.
  process.kill(parentPid, "SIGKILL");

  await waitFor(() => !isAlive(fixturePid), EXIT_TIMEOUT_MS, "the http fixture to exit");
});

test("stdio fixture exits when its parent is SIGKILLed", async () => {
  const { parentPid, fixturePid } = await startFixtureUnderParent(stdioFixture, { detached: false });

  process.kill(parentPid, "SIGKILL");

  await waitFor(() => !isAlive(fixturePid), EXIT_TIMEOUT_MS, "the stdio fixture to exit");
});

test("fixtures shut down on SIGTERM", async () => {
  for (const fixturePath of [httpFixture, stdioFixture]) {
    const child = spawn(process.execPath, [fixturePath], {
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0", MCP_FIXTURE_PARENT_POLL_MS: String(POLL_MS) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    strayPids.add(child.pid);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    // Give the fixture a moment to install its handlers before signalling.
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), EXIT_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
    assert.ok(!isAlive(child.pid), `${path.basename(fixturePath)} should exit on SIGTERM`);
  }
});

test("stdio fixture exits when its stdin closes", async () => {
  const child = spawn(process.execPath, [stdioFixture], {
    env: { ...process.env, MCP_FIXTURE_PARENT_POLL_MS: String(POLL_MS) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  strayPids.add(child.pid);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), EXIT_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
  assert.ok(!isAlive(child.pid), "stdio fixture should exit once stdin reaches EOF");
});
