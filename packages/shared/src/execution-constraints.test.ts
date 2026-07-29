import { describe, expect, it } from "vitest";
import { createAgentHireSchema } from "./validators/agent.js";
import {
  assertPathInAllowlist,
  buildMinimalProcessEnv,
  detectForbiddenEnvSecrets,
  evaluateCanaryHireConsistency,
  findWritePolicyViolations,
  isSafeRelativeWritePath,
  parseGitPorcelainPaths,
} from "./execution-constraints.js";

const canaryWorkspace = "/tmp/tan-575-paperclip-canary";

function validCanaryConstraints(overrides: Record<string, unknown> = {}) {
  return {
    profile: "canary_strict",
    inheritProcessEnv: false,
    forbidSecretEnvBindings: true,
    network: "deny",
    sandboxMode: "workspace-write",
    workspaceAllowlist: [canaryWorkspace],
    writeAllowlist: ["tools/podcast-to-action/docs/TAN-575-assessment-fulfillment-os-canary-draft.md"],
    gitMutation: "deny",
    canCreateTasks: false,
    canAssignTasks: false,
    canCreateAgents: false,
    ...overrides,
  };
}

describe("executionConstraints helpers", () => {
  it("accepts safe relative write paths and rejects escapes", () => {
    expect(isSafeRelativeWritePath("docs/a.md")).toBe(true);
    expect(isSafeRelativeWritePath("../etc/passwd")).toBe(false);
    expect(isSafeRelativeWritePath("/abs/path")).toBe(false);
    expect(isSafeRelativeWritePath("a\\b")).toBe(false);
  });

  it("checks workspace allowlist containment", () => {
    expect(assertPathInAllowlist(`${canaryWorkspace}/nested`, [canaryWorkspace])).toBe(true);
    expect(assertPathInAllowlist("/tmp/other", [canaryWorkspace])).toBe(false);
  });

  it("builds minimal env without inheriting arbitrary process secrets", () => {
    process.env.PAPERCLIP_TEST_CANARY_SECRET = "should-not-leak";
    const env = buildMinimalProcessEnv(
      {
        CODEX_HOME: "/tmp/codex-home",
        PAPERCLIP_API_KEY: "run-token",
        PAPERCLIP_TEST_CANARY_SECRET: "should-not-be-selected",
      },
      ["CODEX_HOME", "PAPERCLIP_API_KEY"],
    );
    expect(env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(env.PAPERCLIP_API_KEY).toBe("run-token");
    expect(env.PAPERCLIP_TEST_CANARY_SECRET).toBeUndefined();
    delete process.env.PAPERCLIP_TEST_CANARY_SECRET;
  });

  it("detects forbidden secret env bindings", () => {
    expect(
      detectForbiddenEnvSecrets({
        OPENAI_API_KEY: "",
        GITHUB_TOKEN: "x",
        NORMAL: "ok",
        AWS_KEY: { type: "secret_ref", secretId: "00000000-0000-0000-0000-000000000001" },
      }),
    ).toEqual(expect.arrayContaining(["GITHUB_TOKEN", "AWS_KEY"]));
  });

  it("detects write policy violations from git path deltas", () => {
    expect(
      findWritePolicyViolations(
        ["tools/podcast-to-action/docs/TAN-575-assessment-fulfillment-os-canary-draft.md", "README.md"],
        ["tools/podcast-to-action/docs/TAN-575-assessment-fulfillment-os-canary-draft.md"],
      ),
    ).toEqual(["README.md"]);
  });

  it("parses git porcelain paths including renames", () => {
    expect(
      parseGitPorcelainPaths(" M README.md\nR  old.md -> tools/podcast-to-action/docs/TAN-575-assessment-fulfillment-os-canary-draft.md\n"),
    ).toEqual([
      "README.md",
      "tools/podcast-to-action/docs/TAN-575-assessment-fulfillment-os-canary-draft.md",
    ]);
  });
});

describe("evaluateCanaryHireConsistency", () => {
  it("passes a complete canary_strict hire payload", () => {
    const result = evaluateCanaryHireConsistency({
      adapterConfig: {
        cwd: canaryWorkspace,
        dangerouslyBypassApprovalsAndSandbox: false,
        executionConstraints: validCanaryConstraints(),
        env: { OPENAI_API_KEY: "" },
      },
      runtimeConfig: {
        heartbeat: { enabled: false, maxConcurrentRuns: 1 },
      },
      permissions: {
        canCreateAgents: false,
        canAssignTasks: false,
        canCreateTasks: false,
      },
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("fails when heartbeat remains enabled", () => {
    const result = evaluateCanaryHireConsistency({
      adapterConfig: {
        cwd: canaryWorkspace,
        executionConstraints: validCanaryConstraints(),
      },
      runtimeConfig: {
        heartbeat: { enabled: true, maxConcurrentRuns: 1 },
      },
      permissions: {
        canCreateAgents: false,
        canAssignTasks: false,
        canCreateTasks: false,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("heartbeat.enabled");
  });
});

describe("createAgentHireSchema + executionConstraints", () => {
  it("accepts a valid canary_strict hire body", () => {
    const parsed = createAgentHireSchema.safeParse({
      name: "tan-575-canary",
      adapterType: "codex_local",
      adapterConfig: {
        cwd: canaryWorkspace,
        dangerouslyBypassApprovalsAndSandbox: false,
        search: false,
        executionConstraints: validCanaryConstraints(),
        env: { OPENAI_API_KEY: "" },
      },
      runtimeConfig: {
        heartbeat: { enabled: false, maxConcurrentRuns: 1 },
      },
      permissions: {
        canCreateAgents: false,
        canAssignTasks: false,
        canCreateTasks: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects absolute writeAllowlist entries", () => {
    const parsed = createAgentHireSchema.safeParse({
      name: "tan-575-canary",
      adapterType: "codex_local",
      adapterConfig: {
        cwd: canaryWorkspace,
        executionConstraints: validCanaryConstraints({
          writeAllowlist: ["/tmp/evil.md"],
        }),
      },
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } },
      permissions: { canCreateAgents: false, canAssignTasks: false, canCreateTasks: false },
    });
    expect(parsed.success).toBe(false);
  });
});
