import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  isCodexLocalFastModeSupported,
  isCodexLocalKnownModel,
  isCodexLocalManualModel,
  modelProfiles,
  models,
} from "./index.js";

describe("codex_local workload model policy", () => {
  it("uses gpt-5.4-mini for the routine Paperclip selection", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.4-mini");
    expect(isCodexLocalKnownModel(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
  });

  it("keeps workload-specific candidates out of the curated picker", () => {
    expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex-spark");
    expect(models.map((model) => model.id)).not.toContain("gpt-5.6-luna");
    expect(models.map((model) => model.id)).not.toContain("gpt-5.6-terra");
    expect(modelProfiles.find((profile) => profile.key === "cheap")?.adapterConfig).toEqual({
      model: DEFAULT_CODEX_LOCAL_MODEL,
    });
  });

  it("keeps unproven manual candidates out of the fast-mode contract", () => {
    for (const model of ["gpt-5.3-codex-spark", "gpt-5.6-luna", "gpt-5.6-terra"]) {
      expect(isCodexLocalManualModel(model)).toBe(true);
      expect(isCodexLocalFastModeSupported(model)).toBe(false);
    }
  });
});
