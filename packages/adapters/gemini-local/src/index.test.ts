import { describe, expect, it } from "vitest";
import {
  isGeminiAntigravityCommand,
  resolveGeminiLocalModel,
  sanitizeGeminiLocalExtraArgs,
} from "./index.js";

describe("gemini_local Antigravity compatibility", () => {
  it("recognizes agy paths and leaves Gemini CLI commands on upstream semantics", () => {
    expect(isGeminiAntigravityCommand("/home/user/.local/bin/agy")).toBe(true);
    expect(isGeminiAntigravityCommand("gemini")).toBe(false);
    expect(resolveGeminiLocalModel("agy", "gemini-2.5-pro")).toBe("gemini-3.1-pro-low");
    expect(resolveGeminiLocalModel("gemini", "gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  it("removes Antigravity-owned flag injection without weakening other commands", () => {
    expect(
      sanitizeGeminiLocalExtraArgs("agy", [
        "--model=unsafe",
        "--prompt",
        "unsafe prompt",
        "--resume",
        "old-session",
        "--dangerously-skip-permissions",
        "--custom-flag",
        "value",
      ]),
    ).toEqual(["--custom-flag", "value"]);
    expect(sanitizeGeminiLocalExtraArgs("gemini", ["--resume", "session"])).toEqual([
      "--resume",
      "session",
    ]);
  });
});
