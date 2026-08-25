import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  isCodexLocalFastModeSupported,
  isCodexLocalKnownModel,
  isCodexLocalManualModel,
  modelProfiles,
  models,
  normalizeCodexModel,
  resolveCodexLocalModel,
} from "./index.js";

describe("codex local adapter metadata", () => {
  it("advertises current GPT-5.6 Codex-capable OpenAI models by default", () => {
    const modelIds = models.map((model) => model.id);

    // Default to the concrete gpt-5.6-luna slug — Codex ships no metadata for the bare gpt-5.6
    // alias, so it must not be advertised or used as the default (it triggers a fallback warning).
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-luna");
    expect(modelIds.slice(0, 3)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(modelIds).not.toContain("gpt-5.6");
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(modelIds).not.toContain("gpt-5.3-codex");
    expect(modelIds).not.toContain("gpt-5.3-codex-spark");
  });

  it("normalizes the legacy bare gpt-5.6 alias to the concrete gpt-5.6-sol slug", () => {
    expect(normalizeCodexModel("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModel("  gpt-5.6  ")).toBe("gpt-5.6-sol");
    // Concrete slugs and unknown/manual model IDs pass through untouched.
    expect(normalizeCodexModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModel("gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeCodexModel("future-model")).toBe("future-model");
    expect(normalizeCodexModel("")).toBe("");
    expect(normalizeCodexModel(null)).toBe("");
  });
});

describe("Codex local defaults", () => {
  it("keeps approval and sandbox bypass disabled by default", () => {
    expect(DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX).toBe(false);
  });
});

describe("codex_local workload model policy", () => {
  it("uses gpt-5.6-luna for the routine Paperclip selection", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-luna");
    expect(isCodexLocalKnownModel(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    // Unlike the mini lane this PR originally proposed, luna is a full 5.6-family
    // model and is fast-mode capable.
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
  });

  it("resolves blank or aliased model config to a concrete model", () => {
    expect(resolveCodexLocalModel("")).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(resolveCodexLocalModel(null)).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(resolveCodexLocalModel("   ")).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(resolveCodexLocalModel("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(resolveCodexLocalModel("gpt-5.5")).toBe("gpt-5.5");
  });

  it("keeps spark out of the curated picker and applies an explicit cheap-profile model", () => {
    expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex-spark");
    // Spark stays a manually configured choice; manual IDs ride the fast-mode pass-through.
    expect(isCodexLocalManualModel("gpt-5.3-codex-spark")).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-5.3-codex-spark")).toBe(true);
    expect(modelProfiles.find((profile) => profile.key === "cheap")?.adapterConfig).toEqual({
      model: DEFAULT_CODEX_LOCAL_MODEL,
    });
  });
});
