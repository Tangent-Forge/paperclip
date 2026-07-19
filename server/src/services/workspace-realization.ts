import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Environment,
  EnvironmentLease,
  ExecutionWorkspaceConfig,
  ExecutionWorkspace,
  ProjectExecutionWorkspacePolicy,
  WorkspaceRealizationRecord,
  WorkspaceRealizationRequest,
} from "@paperclipai/shared";
import type { RealizedExecutionWorkspace } from "./workspace-runtime.js";

const execFileAsync = promisify(execFile);

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeGithubRepoUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return `github.com/${httpsMatch[1].toLowerCase()}/${httpsMatch[2].toLowerCase()}`;
  }
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `github.com/${sshMatch[1].toLowerCase()}/${sshMatch[2].toLowerCase()}`;
  }
  return null;
}

function normalizeRepoIdentity(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return normalizeGithubRepoUrl(trimmed) ?? trimmed.replace(/\/$/, "").replace(/\.git$/i, "").toLowerCase();
}

function readPolicyString(policy: Record<string, unknown> | null | undefined, key: string): string | null {
  return policy && typeof policy[key] === "string" ? readString(policy[key]) : null;
}

type RepositoryRoutingPolicy = {
  enforcement: boolean;
  destinationRepo: string | null;
  defaultBaseBranch: string | null;
  owningProjectId: string | null;
};

export type RepositoryRoutingGuardFailure = {
  reason: "repository_routing_guard_failed";
  codeProducing: boolean;
  governed: boolean;
  canonicalOwnerRepo: string | null;
  owningProjectId: string | null;
  executionWorkspaceId: string | null;
  mismatches: Array<{ field: string; expected: string | null; actual: string | null }>;
};

function parseRepositoryRoutingPolicy(projectPolicy: ProjectExecutionWorkspacePolicy | null | undefined): RepositoryRoutingPolicy {
  const policy = projectPolicy?.pullRequestPolicy && typeof projectPolicy.pullRequestPolicy === "object"
    ? projectPolicy.pullRequestPolicy as Record<string, unknown>
    : null;
  return {
    enforcement: Boolean(policy && (policy.enforcement === true || policy.enabled === true || policy.enforce === true)),
    destinationRepo: normalizeRepoIdentity(readPolicyString(policy, "destinationRepo") ?? readPolicyString(policy, "repoUrl") ?? readPolicyString(policy, "repositoryUrl")),
    defaultBaseBranch: readPolicyString(policy, "defaultBaseBranch"),
    owningProjectId: readPolicyString(policy, "owningProjectId") ?? readPolicyString(policy, "projectId") ?? null,
  };
}

function isCodeProducingRoutedWork(request: WorkspaceRealizationRequest): boolean {
  return request.source.kind === "project_primary" || request.source.strategy === "git_worktree";
}

type GitCommandRunner = (args: string[], cwd: string) => Promise<string | null>;

async function runGitCommand(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return readString(stdout);
  } catch {
    return null;
  }
}

export async function inspectLiveLocalGitRouting(
  cwd: string,
  runGit: GitCommandRunner = runGitCommand,
): Promise<{
  repoRoot: string | null;
  remoteUrl: string | null;
  branchName: string | null;
} | null> {
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!repoRoot) return null;

  const branchName = await runGit(["branch", "--show-current"], repoRoot);
  const configuredRemote = branchName
    ? await runGit(["config", "--get", `branch.${branchName}.remote`], repoRoot)
    : null;
  const remoteNames = configuredRemote && configuredRemote !== "."
    ? [configuredRemote]
    : (await runGit(["remote"], repoRoot))?.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) ?? [];
  const remoteName = remoteNames.length === 1 ? remoteNames[0] : null;
  const remoteUrl = remoteName
    ? normalizeRepoIdentity(await runGit(["remote", "get-url", remoteName], repoRoot))
    : null;

  return {
    repoRoot,
    remoteUrl,
    branchName,
  };
}

function actualMatchesExpected(expected: string | null, actual: string | null): boolean {
  return expected !== null && actual === expected;
}

export async function validateWorkspaceRepositoryRouting(input: {
  request: WorkspaceRealizationRequest;
  executionWorkspace: RealizedExecutionWorkspace;
  projectPolicy?: ProjectExecutionWorkspacePolicy | null;
  persistedExecutionWorkspace?: ExecutionWorkspace | null;
  inspectLiveGit?: typeof inspectLiveLocalGitRouting;
}): Promise<RepositoryRoutingGuardFailure | null> {
  const mismatches: RepositoryRoutingGuardFailure["mismatches"] = [];
  const requestRepo = normalizeRepoIdentity(input.request.source.repoUrl);
  const workspaceRepo = normalizeRepoIdentity(input.executionWorkspace.repoUrl);
  const persistedRepo = normalizeRepoIdentity(input.persistedExecutionWorkspace?.repoUrl ?? null);
  const canonicalRepo = requestRepo ?? persistedRepo ?? workspaceRepo;
  const routingPolicy = parseRepositoryRoutingPolicy(input.projectPolicy);
  const codeProducing = isCodeProducingRoutedWork(input.request);
  const routingMetadataDeclared = Boolean(
    routingPolicy.destinationRepo ||
    routingPolicy.defaultBaseBranch ||
    routingPolicy.owningProjectId,
  );
  const governed = routingPolicy.enforcement || (
    input.projectPolicy?.enabled === true && routingMetadataDeclared
  );
  const expectedRepo = routingPolicy.destinationRepo;
  const expectedBaseRef = routingPolicy.defaultBaseBranch;
  const expectedProjectId = routingPolicy.owningProjectId ?? input.request.source.projectId ?? input.executionWorkspace.projectId ?? input.persistedExecutionWorkspace?.projectId ?? null;
  const expectedBranchName = input.request.source.branchName ?? input.persistedExecutionWorkspace?.branchName ?? input.executionWorkspace.branchName ?? null;

  if (!governed || !codeProducing) return null;

  const requiredValues = (
    expected: string | null,
    entries: Array<{ field: string; actual: string | null }>,
  ) => {
    for (const entry of entries) {
      if (!actualMatchesExpected(expected, entry.actual)) {
        mismatches.push({ field: entry.field, expected, actual: entry.actual });
      }
    }
  };

  if (!expectedRepo) {
    mismatches.push({ field: "projectExecutionWorkspacePolicy.pullRequestPolicy.destinationRepo", expected: null, actual: canonicalRepo });
  } else {
    requiredValues(expectedRepo, [
      { field: "request.source.repoUrl", actual: requestRepo },
      { field: "executionWorkspace.repoUrl", actual: workspaceRepo },
      ...(input.persistedExecutionWorkspace
        ? [{ field: "persistedExecutionWorkspace.repoUrl", actual: persistedRepo }]
        : []),
    ]);
  }

  if (!expectedBaseRef) {
    mismatches.push({ field: "projectExecutionWorkspacePolicy.pullRequestPolicy.defaultBaseBranch", expected: null, actual: input.request.source.repoRef ?? null });
  } else {
    requiredValues(expectedBaseRef, [
      { field: "request.source.repoRef", actual: input.request.source.repoRef ?? null },
      { field: "executionWorkspace.repoRef", actual: input.executionWorkspace.repoRef ?? null },
      ...(input.persistedExecutionWorkspace
        ? [{ field: "persistedExecutionWorkspace.baseRef", actual: input.persistedExecutionWorkspace.baseRef ?? null }]
        : []),
    ]);
  }

  if (!routingPolicy.owningProjectId) {
    mismatches.push({ field: "projectExecutionWorkspacePolicy.pullRequestPolicy.owningProjectId", expected: null, actual: null });
  } else {
    requiredValues(routingPolicy.owningProjectId, [
      { field: "request.source.projectId", actual: input.request.source.projectId ?? null },
      { field: "executionWorkspace.projectId", actual: input.executionWorkspace.projectId ?? null },
      ...(input.persistedExecutionWorkspace
        ? [{ field: "persistedExecutionWorkspace.projectId", actual: input.persistedExecutionWorkspace.projectId ?? null }]
        : []),
    ]);
  }

  if (!expectedBranchName) {
    mismatches.push({ field: "workspace.branchName", expected: "declared execution branch", actual: null });
  } else {
    requiredValues(expectedBranchName, [
      { field: "request.source.branchName", actual: input.request.source.branchName ?? null },
      { field: "executionWorkspace.branchName", actual: input.executionWorkspace.branchName ?? null },
      ...(input.persistedExecutionWorkspace
        ? [{ field: "persistedExecutionWorkspace.branchName", actual: input.persistedExecutionWorkspace.branchName ?? null }]
        : []),
    ]);
  }

  const liveGit = codeProducing
    ? await (input.inspectLiveGit ?? inspectLiveLocalGitRouting)(input.executionWorkspace.cwd)
    : null;
  if (codeProducing) {
    if (!liveGit) {
      if (governed) {
        mismatches.push({ field: "liveGit", expected: "inspectable local git checkout", actual: null });
      }
    } else {
      if (!liveGit.remoteUrl && governed) {
        mismatches.push({ field: "liveGit.remoteUrl", expected: expectedRepo ?? requestRepo, actual: null });
      } else if (requestRepo && liveGit.remoteUrl && requestRepo !== liveGit.remoteUrl) {
        mismatches.push({ field: "liveGit.remoteUrl", expected: requestRepo, actual: liveGit.remoteUrl });
      }
      if (expectedRepo && liveGit.remoteUrl && expectedRepo !== liveGit.remoteUrl) {
        mismatches.push({ field: "liveGit.remoteUrl", expected: expectedRepo, actual: liveGit.remoteUrl });
      }
      if (!liveGit.branchName && governed) {
        mismatches.push({ field: "liveGit.branchName", expected: expectedBranchName, actual: null });
      } else if (expectedBranchName && liveGit.branchName && expectedBranchName !== liveGit.branchName) {
        mismatches.push({ field: "liveGit.branchName", expected: expectedBranchName, actual: liveGit.branchName });
      }
    }
  }

  if (!governed && mismatches.length === 0) return null;
  if (mismatches.length === 0) return null;
  return {
    reason: "repository_routing_guard_failed",
    codeProducing,
    governed,
    canonicalOwnerRepo: canonicalRepo,
    owningProjectId: expectedProjectId,
    executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
    mismatches,
  };
}

function readWorkspaceRealizationRequest(value: unknown): WorkspaceRealizationRequest | null {
  const parsed = parseObject(value);
  if (parsed.version !== 1) return null;
  const source = parseObject(parsed.source);
  const runtimeOverlay = parseObject(parsed.runtimeOverlay);
  const localPath = readString(source.localPath);
  const companyId = readString(parsed.companyId);
  const environmentId = readString(parsed.environmentId);
  const heartbeatRunId = readString(parsed.heartbeatRunId);
  const adapterType = readString(parsed.adapterType);
  if (!localPath || !companyId || !environmentId || !heartbeatRunId || !adapterType) return null;

  return {
    version: 1,
    adapterType,
    companyId,
    environmentId,
    executionWorkspaceId: readString(parsed.executionWorkspaceId),
    issueId: readString(parsed.issueId),
    heartbeatRunId,
    requestedMode: readString(parsed.requestedMode),
    source: {
      kind:
        source.kind === "task_session" || source.kind === "agent_home"
          ? source.kind
          : "project_primary",
      localPath,
      projectId: readString(source.projectId),
      projectWorkspaceId: readString(source.projectWorkspaceId),
      repoUrl: readString(source.repoUrl),
      repoRef: readString(source.repoRef),
      strategy: source.strategy === "git_worktree" ? "git_worktree" : "project_primary",
      branchName: readString(source.branchName),
      worktreePath: readString(source.worktreePath),
    },
    runtimeOverlay: {
      provisionCommand: readString(runtimeOverlay.provisionCommand),
      teardownCommand: readString(runtimeOverlay.teardownCommand),
      cleanupCommand: readString(runtimeOverlay.cleanupCommand),
      workspaceRuntime: Object.keys(parseObject(runtimeOverlay.workspaceRuntime)).length > 0
        ? parseObject(runtimeOverlay.workspaceRuntime)
        : null,
    },
  };
}

export function buildWorkspaceRealizationRequest(input: {
  adapterType: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string;
  requestedMode: string | null;
  workspace: RealizedExecutionWorkspace;
  workspaceConfig: ExecutionWorkspaceConfig | null;
}): WorkspaceRealizationRequest {
  return {
    version: 1,
    adapterType: input.adapterType,
    companyId: input.companyId,
    environmentId: input.environmentId,
    executionWorkspaceId: input.executionWorkspaceId,
    issueId: input.issueId,
    heartbeatRunId: input.heartbeatRunId,
    requestedMode: input.requestedMode,
    source: {
      kind: input.workspace.source,
      localPath: input.workspace.cwd,
      projectId: input.workspace.projectId,
      projectWorkspaceId: input.workspace.workspaceId,
      repoUrl: input.workspace.repoUrl,
      repoRef: input.workspace.repoRef,
      strategy: input.workspace.strategy,
      branchName: input.workspace.branchName,
      worktreePath: input.workspace.worktreePath,
    },
    runtimeOverlay: {
      provisionCommand: input.workspaceConfig?.provisionCommand ?? null,
      teardownCommand: input.workspaceConfig?.teardownCommand ?? null,
      cleanupCommand: input.workspaceConfig?.cleanupCommand ?? null,
      workspaceRuntime: input.workspaceConfig?.workspaceRuntime ?? null,
    },
  };
}

export function buildWorkspaceRealizationRecord(input: {
  environment: Environment;
  lease: EnvironmentLease;
  request: WorkspaceRealizationRequest;
  realizedCwd?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}): WorkspaceRealizationRecord {
  const leaseMetadata = input.lease.metadata ?? {};
  const providerMetadata = input.providerMetadata ?? {};
  const transport =
    input.environment.driver === "ssh" || input.environment.driver === "sandbox" || input.environment.driver === "plugin"
      ? input.environment.driver
      : "local";
  const remotePath =
    readString(providerMetadata.remoteCwd) ??
    readString(leaseMetadata.remoteCwd) ??
    readString(providerMetadata.remotePath) ??
    null;
  const host = readString(leaseMetadata.host);
  const port = readNumber(leaseMetadata.port);
  const username = readString(leaseMetadata.username);
  const sandboxId = readString(leaseMetadata.sandboxId) ?? readString(providerMetadata.sandboxId);

  const sync = (() => {
    if (transport === "local") {
      return {
        strategy: "none" as const,
        prepare: "Use the realized local execution workspace directly.",
        syncBack: null,
      };
    }
    if (transport === "ssh") {
      return {
        strategy: "ssh_git_import_export" as const,
        prepare: "Import the local git workspace to the remote SSH workspace before adapter execution.",
        syncBack: "Export remote SSH workspace changes back to the local execution workspace after adapter execution.",
      };
    }
    if (transport === "sandbox") {
      return {
        strategy: "sandbox_archive_upload_download" as const,
        prepare: "Upload a workspace archive into the sandbox filesystem before adapter execution.",
        syncBack: "Download a workspace archive from the sandbox and mirror it back locally after adapter execution.",
      };
    }
    return {
      strategy: "provider_defined" as const,
      prepare: "Delegate workspace materialization to the plugin environment driver.",
      syncBack: "Delegate result synchronization to the plugin environment driver.",
    };
  })();

  const provider =
    input.lease.provider ??
    (transport === "ssh" ? "ssh" : transport === "local" ? "local" : null);
  const localPath = input.request.source.localPath;
  const summary =
    transport === "local"
      ? `Local workspace realized at ${localPath}.`
      : transport === "ssh"
        ? `SSH workspace realized at ${username ?? "user"}@${host ?? "host"}:${port ?? 22}:${remotePath ?? input.request.source.localPath}.`
        : transport === "sandbox"
          ? `Sandbox workspace realized at ${remotePath ?? "/"}${sandboxId ? ` in ${sandboxId}` : ""}.`
          : `Plugin workspace realized at ${input.realizedCwd ?? remotePath ?? localPath}.`;

  return {
    version: 1,
    transport,
    provider,
    environmentId: input.environment.id,
    leaseId: input.lease.id,
    providerLeaseId: input.lease.providerLeaseId,
    local: {
      path: localPath,
      source: input.request.source.kind,
      strategy: input.request.source.strategy,
      projectId: input.request.source.projectId,
      projectWorkspaceId: input.request.source.projectWorkspaceId,
      repoUrl: input.request.source.repoUrl,
      repoRef: input.request.source.repoRef,
      branchName: input.request.source.branchName,
      worktreePath: input.request.source.worktreePath,
    },
    remote: {
      path: remotePath,
      ...(host ? { host } : {}),
      ...(port ? { port } : {}),
      ...(username ? { username } : {}),
      ...(sandboxId ? { sandboxId } : {}),
    },
    sync,
    bootstrap: {
      command: input.request.runtimeOverlay.provisionCommand,
    },
    rebuild: {
      executionWorkspaceId: input.request.executionWorkspaceId,
      mode: input.request.requestedMode,
      repoUrl: input.request.source.repoUrl,
      repoRef: input.request.source.repoRef,
      localPath,
      remotePath,
      providerLeaseId: input.lease.providerLeaseId,
      metadata: {
        source: input.request.source,
        runtimeOverlay: input.request.runtimeOverlay,
        environmentDriver: input.environment.driver,
        provider,
        providerMetadata,
      },
    },
    summary,
  };
}

export function buildWorkspaceRealizationRecordFromDriverInput(input: {
  environment: Environment;
  lease: EnvironmentLease;
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
  cwd?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}): WorkspaceRealizationRecord {
  const request =
    readWorkspaceRealizationRequest(input.workspace.metadata?.workspaceRealizationRequest) ??
    readWorkspaceRealizationRequest(input.workspace.metadata?.request) ??
    buildWorkspaceRealizationRequest({
      adapterType: "unknown",
      companyId: input.lease.companyId,
      environmentId: input.environment.id,
      executionWorkspaceId: input.lease.executionWorkspaceId,
      issueId: input.lease.issueId,
      heartbeatRunId: input.lease.heartbeatRunId ?? "unknown",
      requestedMode: input.workspace.mode ?? null,
      workspace: {
        baseCwd: input.workspace.localPath ?? input.cwd ?? input.workspace.remotePath ?? "/",
        source: "task_session",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: input.workspace.localPath ?? input.cwd ?? input.workspace.remotePath ?? "/",
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      workspaceConfig: null,
    });

  return buildWorkspaceRealizationRecord({
    environment: input.environment,
    lease: input.lease,
    request,
    realizedCwd: input.cwd ?? null,
    providerMetadata: input.providerMetadata,
  });
}
