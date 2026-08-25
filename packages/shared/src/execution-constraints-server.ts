import fs from "node:fs";
import path from "node:path";
import {
  detectForbiddenEnvSecrets,
  isSafeRelativeWritePath,
  type ExecutionConstraints,
} from "./execution-constraints.js";

export function assertPathInAllowlist(cwd: string, allowlist: string[]): boolean {
  const resolveCandidate = (value: string): string => {
    try {
      // Prefer realpath when available so symlink escapes cannot satisfy string-prefix checks.
      return fs.realpathSync(path.resolve(value));
    } catch {
      return path.resolve(value);
    }
  };
  const resolved = resolveCandidate(cwd);
  return allowlist.some((allowed) => {
    const allowedResolved = resolveCandidate(allowed);
    return resolved === allowedResolved || resolved.startsWith(`${allowedResolved}${path.sep}`);
  });
}

/** Build a process env that does not inherit host secrets. */
export function buildMinimalProcessEnv(
  baseConfiguredEnv: Record<string, string | undefined>,
  allowlist?: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TMP", "TEMP",
  ] as const) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  const allowed = allowlist ? new Set(allowlist) : null;
  for (const [key, value] of Object.entries(baseConfiguredEnv)) {
    if (typeof value !== "string") continue;
    if (allowed && !allowed.has(key)) continue;
    env[key] = value;
  }
  return env;
}

export function evaluateCanaryHireConsistency(input: {
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown> | null | undefined;
}): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const constraints = input.adapterConfig.executionConstraints as ExecutionConstraints | undefined;
  if (!constraints || constraints.profile !== "canary_strict") return { ok: true, issues };
  if (constraints.inheritProcessEnv !== false) issues.push("inheritProcessEnv must be false");
  if (constraints.forbidSecretEnvBindings !== true) issues.push("forbidSecretEnvBindings must be true");
  if (constraints.network !== "deny") issues.push("network must be deny");
  if (constraints.sandboxMode !== "workspace-write") issues.push("sandboxMode must be workspace-write");
  if (constraints.gitMutation !== "deny") issues.push("gitMutation must be deny");
  if (constraints.canCreateTasks !== false) issues.push("canCreateTasks must be false");
  if (constraints.canAssignTasks !== false) issues.push("canAssignTasks must be false");
  if (constraints.canCreateAgents !== false) issues.push("canCreateAgents must be false");

  const heartbeat = (input.runtimeConfig.heartbeat as Record<string, unknown> | undefined) ?? {};
  if (heartbeat.enabled !== false) issues.push("runtimeConfig.heartbeat.enabled must be false");
  if (heartbeat.maxConcurrentRuns !== 1) issues.push("runtimeConfig.heartbeat.maxConcurrentRuns must be 1");
  if (input.adapterConfig.dangerouslyBypassApprovalsAndSandbox === true || input.adapterConfig.dangerouslyBypassSandbox === true) {
    issues.push("bypass flags must be false");
  }
  if (input.adapterConfig.search === true) issues.push("search must be false when network is denied");
  if (!constraints.workspaceAllowlist?.length) issues.push("workspaceAllowlist must be non-empty");
  if (!constraints.writeAllowlist?.length) issues.push("writeAllowlist must be non-empty");
  else if (constraints.writeAllowlist.length !== 1) issues.push("writeAllowlist must contain exactly one relative path for canary_strict");
  else if (!isSafeRelativeWritePath(constraints.writeAllowlist[0] ?? "")) issues.push("writeAllowlist entry must be a safe relative path");
  if (typeof input.adapterConfig.cwd !== "string" || !assertPathInAllowlist(input.adapterConfig.cwd, constraints.workspaceAllowlist ?? [])) {
    issues.push("cwd must be inside workspaceAllowlist");
  }
  if (input.permissions?.canCreateAgents !== false) issues.push("permissions.canCreateAgents must be false");
  if (input.permissions?.canAssignTasks !== false) issues.push("permissions.canAssignTasks must be false");
  if (input.permissions?.canCreateTasks !== false) issues.push("permissions.canCreateTasks must be false");
  if (constraints.forbidSecretEnvBindings && input.adapterConfig.env && typeof input.adapterConfig.env === "object") {
    for (const key of detectForbiddenEnvSecrets(input.adapterConfig.env as Record<string, unknown>)) issues.push(`forbidden env binding: ${key}`);
  }
  return { ok: issues.length === 0, issues };
}
