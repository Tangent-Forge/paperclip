#!/usr/bin/env node
/**
 * Read-only Paperclip fork-health evidence collector.
 * It never fetches, writes, restarts services, or changes Git state.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const run = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    return { error: error.stderr?.toString().trim() || error.message };
  }
};
const text = (value) => (typeof value === "string" ? value : null);
const lines = (value) => (text(value) ? value.split("\n").filter(Boolean) : []);
const git = (...args) => run("git", args);

const branch = text(git("branch", "--show-current")) || "DETACHED";
const head = text(git("rev-parse", "HEAD"));
const originMaster = text(git("rev-parse", "origin/master"));
const upstreamMaster = text(git("rev-parse", "upstream/master"));
const divergence = upstreamMaster && originMaster
  ? text(git("rev-list", "--left-right", "--count", "upstream/master...origin/master"))
  : null;
const [upstreamOnly, forkOnly] = divergence?.split(/\s+/).map(Number) || [null, null];
const trackedChanges = lines(git("status", "--porcelain"));
const untrackedChanges = trackedChanges.filter((line) => line.startsWith("??"));
const service = run("systemctl", ["--user", "show", "paperclip.service", "--property=ActiveState,SubState,WorkingDirectory"]);
const serviceWorkingDirectory = text(service)?.match(/^WorkingDirectory=(.+)$/m)?.[1] || null;
const runtimeCommit = serviceWorkingDirectory
  ? text(run("git", ["-C", serviceWorkingDirectory, "rev-parse", "HEAD"]))
  : null;
const health = run("curl", ["-fsS", "--max-time", "5", "http://127.0.0.1:3100/api/health"]);
let healthPayload = null;
if (text(health)) {
  try { healthPayload = JSON.parse(health); } catch { healthPayload = { raw: health }; }
}

const findings = [];
if (!upstreamMaster) findings.push("missing cached upstream/master reference");
if (!originMaster) findings.push("missing cached origin/master reference");
if (upstreamOnly !== null && upstreamOnly > 100) findings.push(`upstream backlog ${upstreamOnly} exceeds monthly batch threshold`);
if (trackedChanges.length > 0) findings.push(`${trackedChanges.length} local working-tree changes require a disposition record`);
if (untrackedChanges.length > 0) findings.push(`${untrackedChanges.length} untracked paths require preservation or review`);
if (!existsSync(resolve(root, "doc", "plans"))) findings.push("missing plan directory");
if (!text(service)?.includes("ActiveState=active")) findings.push("Paperclip service is not active");
if (!healthPayload || healthPayload.status !== "ok") findings.push("Paperclip health endpoint did not report ok");
if (!runtimeCommit) findings.push("unable to resolve the running service Git commit");
if (serviceWorkingDirectory && resolve(serviceWorkingDirectory, "..") === root && trackedChanges.length > 0) {
  findings.push("Paperclip service runs from the dirty developer checkout; deployment worktree approval remains required");
}

console.log(JSON.stringify({
  schema: "paperclip_fork_health_v1",
  generated_at: new Date().toISOString(),
  repository: {
    root,
    branch,
    head,
    origin_master: originMaster,
    upstream_master_cached: upstreamMaster,
    upstream_only_cached: upstreamOnly,
    fork_only_cached: forkOnly,
  },
  worktree: {
    changed_paths: trackedChanges.length,
    untracked_paths: untrackedChanges.length,
    status: trackedChanges,
  },
  service: {
    state: service,
    working_directory: serviceWorkingDirectory,
    git_commit: runtimeCommit,
    health: healthPayload,
  },
  findings,
  read_only: true,
}, null, 2));
