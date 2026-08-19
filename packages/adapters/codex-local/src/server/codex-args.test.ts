import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js";
import { buildCodexExecArgs } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
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

  it("resolves an omitted model to the default Codex model", () => {
    const result = buildCodexExecArgs({
    });

    expect(result.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(result.fastModeRequested).toBe(false);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      DEFAULT_CODEX_LOCAL_MODEL,
      "-",
    ]);
  });

  it("ignores fast mode when the default Codex model is resolved from an omitted model", () => {
    const result = buildCodexExecArgs({
      fastMode: true,
    });

    expect(result.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.5, gpt-5.4",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      DEFAULT_CODEX_LOCAL_MODEL,
      "-",
    ]);
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex",
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
      "gpt-5.3-codex",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.3-codex",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.3-codex",
      "-",
    ]);
  });

  // Restored 2026-08-12. These three executionConstraints tests were dropped when this
  // file was rewritten for the default-model change, which left the sandbox/bypass
  // guards in codex-args.ts with no coverage at all. That enforcement logic was never
  // touched by this PR -- only its tests went missing -- so they come back unchanged.
  // The extraArgs case matters most: it is the guard against re-widening the sandbox
  // through user-supplied flags.

  it("applies workspace-write sandbox and blocks bypass under network deny", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      dangerouslyBypassApprovalsAndSandbox: false,
      executionConstraints: {
        network: "deny",
        sandboxMode: "workspace-write",
      },
    });
    expect(result.args).toContain("--sandbox");
    expect(result.args).toContain("workspace-write");
    expect(result.args).not.toContain("--search");
    expect(result.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("throws when bypass is requested under denied network", () => {
    expect(() =>
      buildCodexExecArgs({
        model: "gpt-5.4",
        dangerouslyBypassApprovalsAndSandbox: true,
        executionConstraints: { network: "deny" },
      }),
    ).toThrow(/forbid Codex bypass/);
  });

  it("strips extraArgs that would reintroduce search or widen sandbox under constraints", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      executionConstraints: {
        network: "deny",
        sandboxMode: "workspace-write",
      },
      extraArgs: [
        "--search",
        "--search=true",
        "--sandbox",
        "danger-full-access",
        "--sandbox=danger-full-access",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "--skip-git-repo-check",
      ],
    });
    expect(result.args).not.toContain("--search");
    expect(result.args).not.toContain("--search=true");
    expect(result.args).toContain("--sandbox");
    expect(result.args).toContain("workspace-write");
    expect(result.args).not.toContain("danger-full-access");
    expect(result.args).not.toContain("--sandbox=danger-full-access");
    expect(result.args.join(" ")).not.toContain("network_access=true");
    expect(result.args).toContain("--skip-git-repo-check");
  });
});
