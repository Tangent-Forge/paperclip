import { describe, expect, it } from "vitest";
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

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "future-codex-model",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "future-codex-model",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides when model is omitted (CLI default)", () => {
    const result = buildCodexExecArgs({
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
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
      "currently only supported on gpt-5.5, gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "-",
    ]);
  });

  it("adds --dangerously-bypass-approvals-and-sandbox when explicitly requested", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.4",
      "-",
    ]);
  });

  it("adds --approve-for-me and an explicit --sandbox workspace-write when approveForMe is set and not bypassing (SEC-CODEX-LOCAL-AGENTS-BYPASS-SANDBOX-20260816)", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      approveForMe: true,
    });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--approve-for-me",
      "--sandbox",
      "workspace-write",
      "--model",
      "gpt-5.4",
      "-",
    ]);
  });

  it("ignores approveForMe when dangerouslyBypassApprovalsAndSandbox is also set -- bypass already skips approvals", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      dangerouslyBypassApprovalsAndSandbox: true,
      approveForMe: true,
    });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.4",
      "-",
    ]);
  });

  it("adds neither flag by default (sandboxed, no auto-approval) when neither option is set", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
    });

    expect(result.args).toEqual(["exec", "--json", "--model", "gpt-5.4", "-"]);
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
});
