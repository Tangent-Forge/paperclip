import { describe, expect, it } from "vitest";

import {
  inspectLiveLocalGitRouting,
  validateWorkspaceRepositoryRouting,
  type RepositoryRoutingGuardFailure,
} from "../services/workspace-realization.ts";
import type { ExecutionWorkspace, WorkspaceRealizationRequest } from "@paperclipai/shared";
import type { RealizedExecutionWorkspace } from "../services/workspace-runtime.ts";

async function inspectLiveGit() {
  return {
    repoRoot: "/workspace/project",
    remoteUrl: "github.com/paperclipai/paperclip",
    branchName: "tan-459/guard",
  };
}

function makeRequest(overrides: Partial<WorkspaceRealizationRequest["source"]> = {}): WorkspaceRealizationRequest {
  return {
    version: 1,
    adapterType: "claude_local",
    companyId: "company-1",
    environmentId: "env-1",
    executionWorkspaceId: "ew-1",
    issueId: null,
    heartbeatRunId: "run-1",
    requestedMode: null,
    source: {
      kind: "project_primary",
      localPath: "/workspace/project",
      projectId: "project-1",
      projectWorkspaceId: "ws-1",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      repoRef: "main",
      strategy: "git_worktree",
      branchName: "tan-459/guard",
      worktreePath: "/workspace/project/.worktrees/tan-459",
      ...overrides,
    },
    runtimeOverlay: {
      provisionCommand: null,
      teardownCommand: null,
      cleanupCommand: null,
      workspaceRuntime: null,
    },
  };
}

function makeWorkspace(overrides: Partial<RealizedExecutionWorkspace> = {}): RealizedExecutionWorkspace {
  return {
    baseCwd: "/workspace",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "ws-1",
    repoUrl: "git@github.com:paperclipai/paperclip.git",
    repoRef: "main",
    strategy: "git_worktree",
    cwd: "/workspace/project",
    branchName: "tan-459/guard",
    worktreePath: "/workspace/project/.worktrees/tan-459",
    warnings: [],
    created: false,
    ...overrides,
  };
}

function makePersistedWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "ew-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "ws-1",
    sourceIssueId: null,
    mode: "standard",
    strategyType: "git_worktree",
    name: "workspace",
    status: "open",
    cwd: "/workspace/project",
    repoUrl: "https://github.com/paperclipai/paperclip.git",
    baseRef: "main",
    branchName: "tan-459/guard",
    providerType: "local",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("validateWorkspaceRepositoryRouting", () => {
  it("accepts HTTPS and SSH repo URLs as the same repository", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest({ repoUrl: "https://github.com/paperclipai/paperclip.git" }),
      executionWorkspace: makeWorkspace({ repoUrl: "git@github.com:paperclipai/paperclip.git" }),
      persistedExecutionWorkspace: makePersistedWorkspace({ repoUrl: "git@github.com:paperclipai/paperclip.git" }),
      inspectLiveGit,
      projectPolicy: {
        enabled: true,
        pullRequestPolicy: {
          enforcement: true,
          destinationRepo: "git@github.com:paperclipai/paperclip.git",
          defaultBaseBranch: "main",
          owningProjectId: "project-1",
        },
      },
    });

    expect(result).toBeNull();
  });

  it("preserves case-sensitive repository paths outside GitHub", async () => {
    const lowerCaseRepo = "https://gitlab.example/Team/repo.git";
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest({ repoUrl: lowerCaseRepo }),
      executionWorkspace: makeWorkspace({ repoUrl: lowerCaseRepo }),
      persistedExecutionWorkspace: makePersistedWorkspace({ repoUrl: lowerCaseRepo }),
      inspectLiveGit: async () => ({
        repoRoot: "/workspace/project",
        remoteUrl: "gitlab.example/Team/repo",
        branchName: "tan-459/guard",
      }),
      projectPolicy: {
        enabled: true,
        pullRequestPolicy: {
          enforcement: true,
          destinationRepo: "git@gitlab.example:Team/Repo.git",
          defaultBaseBranch: "main",
          owningProjectId: "project-1",
        },
      },
    });

    expect(result?.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "request.source.repoUrl" }),
        expect.objectContaining({ field: "liveGit.remoteUrl" }),
      ]),
    );
  });

  it("fails closed when required governed fields are missing", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest({ repoUrl: null, repoRef: null, projectId: null }),
      executionWorkspace: makeWorkspace({ repoUrl: null, repoRef: null, projectId: null }),
      persistedExecutionWorkspace: makePersistedWorkspace({ repoUrl: null, baseRef: null, projectId: null }),
      inspectLiveGit,
      projectPolicy: {
        enabled: true,
        pullRequestPolicy: {
          enforcement: true,
        },
      },
    });

    expect(result).not.toBeNull();
    expect((result as RepositoryRoutingGuardFailure).mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "projectExecutionWorkspacePolicy.pullRequestPolicy.destinationRepo" }),
        expect.objectContaining({ field: "projectExecutionWorkspacePolicy.pullRequestPolicy.defaultBaseBranch" }),
        expect.objectContaining({ field: "projectExecutionWorkspacePolicy.pullRequestPolicy.owningProjectId" }),
      ]),
    );
  });

  it("fails closed on repo, base branch, project, and live branch mismatches", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest({
        repoUrl: "https://github.com/paperclipai/other-repo.git",
        repoRef: "release",
        projectId: "project-2",
      }),
      executionWorkspace: makeWorkspace({
        repoUrl: "git@github.com:paperclipai/paperclip.git",
        branchName: "feature/wrong-branch",
        projectId: "project-2",
      }),
      persistedExecutionWorkspace: makePersistedWorkspace({
        repoUrl: "git@github.com:paperclipai/paperclip.git",
        baseRef: "main",
        projectId: "project-2",
      }),
      inspectLiveGit,
      projectPolicy: {
        enabled: true,
        pullRequestPolicy: {
          enforcement: true,
          destinationRepo: "https://github.com/paperclipai/paperclip.git",
          defaultBaseBranch: "main",
          owningProjectId: "project-1",
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.mismatches.map((m) => m.field)).toEqual(
      expect.arrayContaining([
        "request.source.repoUrl",
        "request.source.repoRef",
        "request.source.projectId",
        "executionWorkspace.branchName",
      ]),
    );
  });

  it("rejects contradictory realized and persisted metadata even when request metadata is correct", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest(),
      executionWorkspace: makeWorkspace({ repoRef: "release", projectId: "project-2", branchName: "feature/wrong" }),
      persistedExecutionWorkspace: makePersistedWorkspace({ repoUrl: "https://github.com/paperclipai/other.git", baseRef: "release", projectId: "project-2", branchName: "feature/wrong" }),
      inspectLiveGit,
      projectPolicy: {
        enabled: true,
        pullRequestPolicy: {
          enforcement: true,
          destinationRepo: "https://github.com/paperclipai/paperclip.git",
          defaultBaseBranch: "main",
          owningProjectId: "project-1",
        },
      },
    });

    expect(result?.mismatches.map((m) => m.field)).toEqual(
      expect.arrayContaining([
        "executionWorkspace.repoRef",
        "executionWorkspace.projectId",
        "executionWorkspace.branchName",
        "persistedExecutionWorkspace.repoUrl",
        "persistedExecutionWorkspace.baseRef",
        "persistedExecutionWorkspace.projectId",
        "persistedExecutionWorkspace.branchName",
      ]),
    );
  });

  it("passes when governed routing inputs and live git agree", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest(),
      executionWorkspace: makeWorkspace(),
      persistedExecutionWorkspace: makePersistedWorkspace(),
      inspectLiveGit,
      projectPolicy: {
        enabled: true,
        pullRequestPolicy: {
          enforcement: true,
          destinationRepo: "https://github.com/paperclipai/paperclip.git",
          defaultBaseBranch: "main",
          owningProjectId: "project-1",
        },
      },
    });

    expect(result).toBeNull();
  });

  it("fails closed when an enforced routing policy omits its owning project even when workspace metadata has one", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest(),
      executionWorkspace: makeWorkspace(),
      persistedExecutionWorkspace: makePersistedWorkspace(),
      inspectLiveGit,
      projectPolicy: {
        enabled: true,
        pullRequestPolicy: {
          enforcement: true,
          destinationRepo: "https://github.com/paperclipai/paperclip.git",
          defaultBaseBranch: "main",
        },
      },
    });

    expect(result?.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "projectExecutionWorkspacePolicy.pullRequestPolicy.owningProjectId" }),
      ]),
    );
  });

  it("does not infer routing governance from workspaceStrategy alone", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest({ repoUrl: null, repoRef: null, projectId: null, strategy: "project_primary", branchName: null }),
      executionWorkspace: makeWorkspace({ repoUrl: null, repoRef: null, projectId: null, branchName: null }),
      persistedExecutionWorkspace: makePersistedWorkspace({ repoUrl: null, baseRef: null, projectId: null, branchName: null }),
      inspectLiveGit,
      projectPolicy: {
        enabled: true,
        workspaceStrategy: { type: "git_worktree", baseRef: "main" },
      },
    });

    expect(result).toBeNull();
  });

  it("fails closed when pull-request enforcement is true even if the top-level workspace policy is disabled", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest(),
      executionWorkspace: makeWorkspace(),
      persistedExecutionWorkspace: makePersistedWorkspace(),
      inspectLiveGit,
      projectPolicy: {
        enabled: false,
        pullRequestPolicy: {
          enforcement: true,
          destinationRepo: "https://github.com/paperclipai/other.git",
          defaultBaseBranch: "main",
          owningProjectId: "project-1",
        },
      },
    });

    expect(result?.governed).toBe(true);
    expect(result?.mismatches).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "request.source.repoUrl" })]),
    );
  });

  it("preserves compatibility for contradictory metadata when no routing policy exists", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest({ repoUrl: "https://github.com/paperclipai/request.git", repoRef: "request-base", projectId: "request-project" }),
      executionWorkspace: makeWorkspace({ repoUrl: "https://github.com/paperclipai/execution.git", repoRef: "execution-base", projectId: "execution-project", branchName: "execution-branch" }),
      persistedExecutionWorkspace: makePersistedWorkspace({ repoUrl: "https://github.com/paperclipai/persisted.git", baseRef: "persisted-base", projectId: "persisted-project", branchName: "persisted-branch" }),
      inspectLiveGit,
      projectPolicy: null,
    });

    expect(result).toBeNull();
  });

  it("inspects the branch-configured Git remote instead of assuming origin", async () => {
    const calls: string[] = [];
    const result = await inspectLiveLocalGitRouting("/workspace/project", async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (command === "rev-parse --show-toplevel") return "/workspace/project";
      if (command === "branch --show-current") return "tan-459/guard";
      if (command === "config --get branch.tan-459/guard.remote") return "upstream";
      if (command === "remote get-url upstream") return "git@github.com:paperclipai/paperclip.git";
      return null;
    });

    expect(result).toEqual({
      repoRoot: "/workspace/project",
      remoteUrl: "github.com/paperclipai/paperclip",
      branchName: "tan-459/guard",
    });
    expect(calls).toContain("remote get-url upstream");
    expect(calls).not.toContain("remote get-url origin");
  });

  it("prefers the branch push remote when multiple remotes are configured", async () => {
    const calls: string[] = [];
    const result = await inspectLiveLocalGitRouting("/workspace/project", async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (command === "rev-parse --show-toplevel") return "/workspace/project";
      if (command === "branch --show-current") return "tan-459/guard";
      if (command === "config --get branch.tan-459/guard.pushRemote") return "fork";
      if (command === "remote get-url fork") return "git@github.com:tangent-forge/paperclip.git";
      if (command === "remote") return "origin\nupstream\nfork";
      return null;
    });

    expect(result).toEqual({
      repoRoot: "/workspace/project",
      remoteUrl: "github.com/tangent-forge/paperclip",
      branchName: "tan-459/guard",
    });
    expect(calls).toContain("remote get-url fork");
    expect(calls).not.toContain("remote");
  });

  it("passes compatibility mode when no routing policy is present", async () => {
    const result = await validateWorkspaceRepositoryRouting({
      request: makeRequest({ repoUrl: null, repoRef: null, projectId: null, strategy: "project_primary" }),
      executionWorkspace: makeWorkspace({ repoUrl: null, repoRef: null, projectId: null }),
      persistedExecutionWorkspace: makePersistedWorkspace({ repoUrl: null, baseRef: null, projectId: null }),
      inspectLiveGit,
      projectPolicy: null,
    });

    expect(result).toBeNull();
  });
});
