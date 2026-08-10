import { describe, expect, it } from "vitest";

import {
  buildHeartbeatExecutionFailurePersistence,
  WorkspaceValidationFailure,
} from "../services/heartbeat.ts";
import { EnvironmentRunError } from "../services/environment-run-orchestrator.ts";

describe("buildHeartbeatExecutionFailurePersistence", () => {
  it("preserves repository routing guard failures as actionable run failures", () => {
    const failure = new EnvironmentRunError(
      "repository_routing_guard_failed",
      "Repository routing validation failed before adapter execution.",
      {
        environmentId: "env-1",
        driver: "local",
        details: {
          reason: "repository_routing_guard_failed",
          codeProducing: true,
          governed: true,
          canonicalOwnerRepo: "github.com/paperclipai/paperclip",
          owningProjectId: "project-1",
          executionWorkspaceId: "ew-1",
          mismatches: [
            {
              field: "liveGit.remoteUrl",
              expected: "github.com/paperclipai/paperclip",
              actual: "github.com/batkins33/DocTR_Process",
            },
          ],
        },
      },
    );

    expect(buildHeartbeatExecutionFailurePersistence(failure)).toEqual({
      errorCode: "repository_routing_guard_failed",
      resultJson: {
        reason: "repository_routing_guard_failed",
        environmentId: "env-1",
        driver: "local",
        repositoryRoutingGuardFailure: {
          reason: "repository_routing_guard_failed",
          codeProducing: true,
          governed: true,
          canonicalOwnerRepo: "github.com/paperclipai/paperclip",
          owningProjectId: "project-1",
          executionWorkspaceId: "ew-1",
          mismatches: [
            {
              field: "liveGit.remoteUrl",
              expected: "github.com/paperclipai/paperclip",
              actual: "github.com/batkins33/DocTR_Process",
            },
          ],
        },
      },
    });
  });

  it("keeps existing workspace validation failure metadata intact", () => {
    const failure = new WorkspaceValidationFailure("Invalid workspace", {
      workspaceValidation: { reason: "missing_git_metadata" },
    });

    expect(buildHeartbeatExecutionFailurePersistence(failure)).toEqual({
      errorCode: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: { reason: "missing_git_metadata" },
      },
    });
  });
});
