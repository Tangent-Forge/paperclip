import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { models as geminiFallbackModels } from "@paperclipai/adapter-gemini-local";
import {
  humanizeGeminiModelId,
  listGeminiModelsForContext,
  parseAgyModelList,
  refreshGeminiModelsForContext,
  resetGeminiModelsCacheForTests,
  resetGeminiModelsRunnerForTests,
  setGeminiModelsRunnerForTests,
} from "../adapters/gemini-models.js";

// Verbatim shape of `agy models` output — bare ids, one per line, no labels.
const AGY_OUTPUT = [
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.1-pro-high",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
].join("\n");

const AGY = "/home/user/.local/bin/agy";

describe("gemini model discovery", () => {
  beforeEach(() => {
    resetGeminiModelsCacheForTests();
    resetGeminiModelsRunnerForTests();
  });

  afterEach(() => {
    resetGeminiModelsCacheForTests();
    resetGeminiModelsRunnerForTests();
  });

  it("parses bare ids and ignores banner lines", () => {
    const parsed = parseAgyModelList(`Available models:\n\n${AGY_OUTPUT}\n\ngemini-3.6-flash-high\n`);
    expect(parsed.map((m) => m.id)).toEqual([
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
  });

  it("builds readable labels from slugs", () => {
    expect(humanizeGeminiModelId("gemini-3.6-flash-high")).toBe("Gemini 3.6 Flash High");
    expect(humanizeGeminiModelId("claude-opus-4-6-thinking")).toBe("Claude Opus 4.6 Thinking");
    expect(humanizeGeminiModelId("gpt-oss-120b-medium")).toBe("GPT OSS 120B Medium");
  });

  it("returns the live catalog when the command is agy", async () => {
    setGeminiModelsRunnerForTests(async () => AGY_OUTPUT);
    const models = await listGeminiModelsForContext({ command: AGY });
    expect(models.map((m) => m.id)).toContain("gemini-3.6-flash-high");
    // The newest models are absent from the static catalog — that was the bug.
    expect(geminiFallbackModels.map((m) => m.id)).not.toContain("gemini-3.6-flash-high");
  });

  it("does not shell out for the plain Gemini CLI, which has no models subcommand", async () => {
    let called = false;
    setGeminiModelsRunnerForTests(async () => {
      called = true;
      return AGY_OUTPUT;
    });
    const models = await listGeminiModelsForContext({ command: "gemini" });
    expect(called).toBe(false);
    expect(models.map((m) => m.id)).toEqual(geminiFallbackModels.map((m) => m.id));
  });

  it("layers agent env overrides onto process.env instead of replacing it", async () => {
    // Regression: subscription-isolated agents carry `env: {}`, which is truthy.
    // `context.env ?? process.env` therefore handed agy an empty environment and it
    // died with "$HOME is not defined", silently degrading to the static catalog.
    let seen: NodeJS.ProcessEnv | null = null;
    setGeminiModelsRunnerForTests(async (_cmd, env) => {
      seen = env;
      return AGY_OUTPUT;
    });
    await listGeminiModelsForContext({ command: AGY, env: {} });
    expect(seen).not.toBeNull();
    expect(seen!.HOME).toBe(process.env.HOME);
    expect(seen!.PATH).toBe(process.env.PATH);
  });

  it("still lets an explicit override win over the inherited value", async () => {
    let seen: NodeJS.ProcessEnv | null = null;
    setGeminiModelsRunnerForTests(async (_cmd, env) => {
      seen = env;
      return AGY_OUTPUT;
    });
    await listGeminiModelsForContext({ command: AGY, env: { GEMINI_TEST_MARKER: "override" } });
    expect(seen!.GEMINI_TEST_MARKER).toBe("override");
    expect(seen!.HOME).toBe(process.env.HOME);
  });

  it("falls back to the static catalog when discovery fails", async () => {
    setGeminiModelsRunnerForTests(async () => {
      throw new Error("agy unauthenticated");
    });
    const models = await listGeminiModelsForContext({ command: AGY });
    expect(models.map((m) => m.id)).toEqual(geminiFallbackModels.map((m) => m.id));
  });

  it("caches per command and bypasses the cache on refresh", async () => {
    let calls = 0;
    setGeminiModelsRunnerForTests(async () => {
      calls += 1;
      return AGY_OUTPUT;
    });
    await listGeminiModelsForContext({ command: AGY });
    await listGeminiModelsForContext({ command: AGY });
    expect(calls).toBe(1);
    await refreshGeminiModelsForContext({ command: AGY });
    expect(calls).toBe(2);
  });
});
