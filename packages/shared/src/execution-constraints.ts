export type ExecutionConstraints = {
  profile?: "canary_strict";
  inheritProcessEnv: boolean;
  envAllowlist?: string[];
  forbidSecretEnvBindings: boolean;
  network: "allow" | "deny";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  workspaceAllowlist: string[];
  writeAllowlist: string[];
  gitMutation: "allow" | "deny";
  canCreateTasks: boolean;
  canAssignTasks: boolean;
  canCreateAgents: boolean;
};

export function parseExecutionConstraints(config: unknown): ExecutionConstraints | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>).executionConstraints;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as ExecutionConstraints;
}

export function isSafeRelativeWritePath(candidate: string): boolean {
  if (!candidate || typeof candidate !== "string") return false;
  if (candidate.includes("\\")) return false;
  const normalized = normalizeRelativePosixPath(candidate);
  return normalized !== null;
}

export function detectForbiddenEnvSecrets(env: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const looksSecret = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key);
    const isEmptyOpenAiOverride =
      key === "OPENAI_API_KEY" &&
      (value === "" ||
        (typeof value === "object" &&
          value !== null &&
          (value as { type?: string; value?: string }).type === "plain" &&
          (value as { value?: string }).value === ""));
    if (looksSecret && !isEmptyOpenAiOverride) issues.push(key);
    if (typeof value === "object" && value !== null && (value as { type?: string }).type === "secret_ref") {
      issues.push(key);
    }
  }
  return issues;
}

export function isGitPathAllowed(changedPath: string, writeAllowlist: string[]): boolean {
  const normalized = normalizeRelativePosixPath(changedPath);
  if (normalized === null) return false;
  return writeAllowlist.some((allowed) => {
    const normalizedAllowed = normalizeRelativePosixPath(allowed);
    return normalizedAllowed !== null &&
      (normalized === normalizedAllowed || normalized.startsWith(`${normalizedAllowed}/`));
  });
}

function normalizeRelativePosixPath(value: string): string | null {
  const candidate = value.replace(/\\/g, "/");
  if (!candidate || candidate.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of candidate.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/") || ".";
}

export function parseGitPorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const moved = line.slice(3).split(" -> ");
    const filePath = (moved[moved.length - 1] ?? "").trim().replace(/^"|"$/g, "");
    if (filePath) paths.push(filePath);
  }
  return paths;
}

export function findWritePolicyViolations(
  changedPaths: string[],
  writeAllowlist: string[],
): string[] {
  if (writeAllowlist.length === 0) {
    return [...changedPaths];
  }
  return changedPaths.filter((filePath) => !isGitPathAllowed(filePath, writeAllowlist));
}
