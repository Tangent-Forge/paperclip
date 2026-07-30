import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  isCodexLocalKnownModel,
  modelProfiles,
} from "./index.js";

describe("codex_local workload model policy", () => {
  it("uses the configured default Paperclip selection", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBeTruthy();
    expect(isCodexLocalKnownModel(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
  });

  it("sets the cheap profile to an explicit DEFAULT_CODEX_LOCAL_MODEL override", () => {
    expect(modelProfiles.find((profile) => profile.key === "cheap")?.adapterConfig).toEqual({
      model: DEFAULT_CODEX_LOCAL_MODEL,
    });
  });
});
