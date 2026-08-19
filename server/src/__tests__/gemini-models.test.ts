import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { models as fallback } from "@paperclipai/adapter-gemini-local";
import {
  humanizeGeminiModelId,
  listGeminiModelsForContext,
  parseAgyModelList,
  refreshGeminiModelsForContext,
  resetGeminiModelsCacheForTests,
  resetGeminiModelsRunnerForTests,
  setGeminiModelsRunnerForTests,
} from "../adapters/gemini-models.js";

const agy = "/home/user/.local/bin/agy";
const output = "Fetching available models...\n" +
  "gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n" +
  "claude-opus-4-6-thinking\tClaude Opus 4.6 Thinking\n";

describe("Antigravity Gemini model discovery", () => {
  beforeEach(() => { resetGeminiModelsCacheForTests(); resetGeminiModelsRunnerForTests(); });
  afterEach(() => { resetGeminiModelsCacheForTests(); resetGeminiModelsRunnerForTests(); });

  it("parses labeled rows and ignores banners", () => {
    expect(parseAgyModelList(output)).toEqual([
      { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
      { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 Thinking" },
    ]);
    expect(humanizeGeminiModelId("gpt-oss-120b-medium")).toBe("GPT OSS 120B Medium");
  });

  it("discovers only for agy and layers environment overrides", async () => {
    let called = false;
    let seen: NodeJS.ProcessEnv | null = null;
    setGeminiModelsRunnerForTests(async (_command, env) => { called = true; seen = env; return output; });
    const discovered = await listGeminiModelsForContext({ command: agy, env: {} });
    expect(called).toBe(true);
    expect(seen?.HOME).toBe(process.env.HOME);
    expect(discovered[0].id).toBe("gemini-3.6-flash-high");
    called = false;
    expect(await listGeminiModelsForContext({ command: "gemini" })).toEqual(fallback);
    expect(called).toBe(false);
  });

  it("falls back and refreshes without making discovery mandatory", async () => {
    let calls = 0;
    setGeminiModelsRunnerForTests(async () => { calls += 1; return output; });
    await listGeminiModelsForContext({ command: agy });
    await listGeminiModelsForContext({ command: agy });
    expect(calls).toBe(1);
    await refreshGeminiModelsForContext({ command: agy });
    expect(calls).toBe(2);
    setGeminiModelsRunnerForTests(async () => { throw new Error("unauthenticated"); });
    resetGeminiModelsCacheForTests();
    await expect(listGeminiModelsForContext({ command: agy })).resolves.toEqual(fallback);
  });
});
