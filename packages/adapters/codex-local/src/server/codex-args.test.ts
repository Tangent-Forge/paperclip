import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js";

describe("buildCodexExecArgs", () => {
  it("rewrites the legacy bare gpt-5.6 alias to gpt-5.6-sol and applies fast mode", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.6",
      fastMode: true,
    });

    expect(result.model).toBe("gpt-5.6-sol");
    expect(result.args).toContain("gpt-5.6-sol");
    expect(result.args).not.toContain("gpt-5.6");
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
  });

  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for GPT-5.5", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for manual models until support is proven", () => {
    const result = buildCodexExecArgs({
      model: "future-codex-model",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.5, gpt-5.4",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "future-codex-model",
      "-",
    ]);
  });

  it("falls blank/omitted model config through to DEFAULT_CODEX_LOCAL_MODEL with --model", () => {
    for (const config of [{}, { model: "" }, { model: "   " }, { model: null }, { model: undefined }]) {
      const result = buildCodexExecArgs(config as Record<string, unknown>);
      expect(result.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
      expect(result.args).toEqual(["exec", "--json", "--model", DEFAULT_CODEX_LOCAL_MODEL, "-"]);
    }
  });

  it("enables Codex fast mode overrides when model is omitted (resolved default)", () => {
    const result = buildCodexExecArgs({
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      DEFAULT_CODEX_LOCAL_MODEL,
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for known unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5",
      "-",
    ]);
  });

  it("ignores fast mode for gpt-5.4-mini", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4-mini",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.4-mini",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.5",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-",
    ]);
  });

  it("does not add a second --skip-git-repo-check when extraArgs already carry it", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.5",
        extraArgs: ["--skip-git-repo-check"],
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "--skip-git-repo-check",
      "-",
    ]);
  });

  it("does not add a second --skip-git-repo-check when the legacy args field carries it", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.5",
        args: ["--skip-git-repo-check"],
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
  });

  it("keeps the operator's --skip-git-repo-check when the sandbox injection is not requested", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      extraArgs: ["--skip-git-repo-check"],
    });

    expect(result.args.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
  });

  it("applies workspace-write sandbox and blocks bypass under network deny", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      dangerouslyBypassApprovalsAndSandbox: false,
      executionConstraints: { network: "deny", sandboxMode: "workspace-write" },
    });
    expect(result.args).toContain("--sandbox");
    expect(result.args).toContain("workspace-write");
    expect(result.args).not.toContain("--search");
    expect(result.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("throws when bypass is requested under denied network", () => {
    expect(() => buildCodexExecArgs({ model: "gpt-5.4", dangerouslyBypassApprovalsAndSandbox: true, executionConstraints: { network: "deny" } })).toThrow(/forbid Codex bypass/);
  });

  it("strips extraArgs that would reintroduce search or widen sandbox under constraints", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      executionConstraints: { network: "deny", sandboxMode: "workspace-write" },
      extraArgs: ["--search", "--search=true", "--sandbox", "danger-full-access", "--sandbox=danger-full-access", "-c", "sandbox_workspace_write.network_access=true", "--skip-git-repo-check"],
    });
    expect(result.args).not.toContain("--search");
    expect(result.args).toContain("--sandbox");
    expect(result.args).toContain("workspace-write");
    expect(result.args).not.toContain("danger-full-access");
    expect(result.args.join(" ")).not.toContain("network_access=true");
    expect(result.args).toContain("--skip-git-repo-check");
  });
});
