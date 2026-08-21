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
  setGeminiModelsClockForTests,
} from "../adapters/gemini-models.js";

const agy = "/home/user/.local/bin/agy";
const output = "Fetching available models...\n" +
  "gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n" +
  "claude-opus-4-6-thinking\tClaude Opus 4.6 Thinking\n";

const scope = (companyId: string, fingerprint = "credential-a") => ({
  companyId,
  principalId: "agent-1",
  providerAccountFingerprint: fingerprint,
});

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
    const discovered = await listGeminiModelsForContext({ command: agy, env: {}, cacheScope: scope("company-a") });
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
    await listGeminiModelsForContext({ command: agy, cacheScope: scope("company-a") });
    await listGeminiModelsForContext({ command: agy, cacheScope: scope("company-a") });
    expect(calls).toBe(1);
    await refreshGeminiModelsForContext({ command: agy, cacheScope: scope("company-a") });
    expect(calls).toBe(2);
    setGeminiModelsRunnerForTests(async () => { throw new Error("unauthenticated"); });
    resetGeminiModelsCacheForTests();
    await expect(listGeminiModelsForContext({ command: agy, cacheScope: scope("company-a") })).resolves.toEqual(fallback);
  });

  it("isolates same-command discovery by company and principal scope", async () => {
    let calls = 0;
    setGeminiModelsRunnerForTests(async (_command, env) => {
      calls += 1;
      return env.GEMINI_TEST_COMPANY === "company-b" ? "gemini-company-b-model" : "gemini-company-a-model";
    });
    const common = { command: agy, env: { HOME: "/same/home" } };
    const companyA = await listGeminiModelsForContext({ ...common, env: { ...common.env, GEMINI_TEST_COMPANY: "company-a" }, cacheScope: scope("company-a") });
    const companyB = await listGeminiModelsForContext({ ...common, env: { ...common.env, GEMINI_TEST_COMPANY: "company-b" }, cacheScope: scope("company-b") });
    const companyAAgain = await listGeminiModelsForContext({ ...common, env: { ...common.env, GEMINI_TEST_COMPANY: "company-a" }, cacheScope: scope("company-a") });

    expect(companyA[0]?.id).toBe("gemini-company-a-model");
    expect(companyB[0]?.id).toBe("gemini-company-b-model");
    expect(companyAAgain[0]?.id).toBe("gemini-company-a-model");
    expect(calls).toBe(2);
  });

  it("partitions credential changes and expires entries", async () => {
    let calls = 0;
    let clock = 1_000;
    setGeminiModelsClockForTests(() => clock);
    setGeminiModelsRunnerForTests(async () => {
      calls += 1;
      return `gemini-model-${calls}`;
    });
    const base = { command: agy, env: { HOME: "/same/home" } };
    await expect(listGeminiModelsForContext({ ...base, cacheScope: scope("company-a", "credential-a") })).resolves.toMatchObject([{ id: "gemini-model-1" }]);
    await expect(listGeminiModelsForContext({ ...base, cacheScope: scope("company-a", "credential-b") })).resolves.toMatchObject([{ id: "gemini-model-2" }]);
    clock += 60_001;
    await expect(listGeminiModelsForContext({ ...base, cacheScope: scope("company-a", "credential-a") })).resolves.toMatchObject([{ id: "gemini-model-3" }]);
    expect(calls).toBe(3);
  });

  it("does not leak entitlement metadata across concurrent company requests", async () => {
    let calls = 0;
    setGeminiModelsRunnerForTests(async (_command, env) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return env.GEMINI_TEST_COMPANY === "company-b"
        ? "gemini-company-b-entitlement"
        : "gemini-company-a-entitlement";
    });

    const common = { command: agy, env: { HOME: "/same/home" } };
    const [companyA, companyB] = await Promise.all([
      listGeminiModelsForContext({
        ...common,
        env: { ...common.env, GEMINI_TEST_COMPANY: "company-a" },
        cacheScope: scope("company-a", "account-a"),
      }),
      listGeminiModelsForContext({
        ...common,
        env: { ...common.env, GEMINI_TEST_COMPANY: "company-b" },
        cacheScope: scope("company-b", "account-b"),
      }),
    ]);

    expect(companyA[0]?.id).toBe("gemini-company-a-entitlement");
    expect(companyB[0]?.id).toBe("gemini-company-b-entitlement");
    expect(calls).toBe(2);
  });

  it("does not cache an unscoped or explicitly non-cacheable discovery", async () => {
    let calls = 0;
    setGeminiModelsRunnerForTests(async () => { calls += 1; return output; });
    await listGeminiModelsForContext({ command: agy, cacheScope: { ...scope("company-a"), cacheable: false } });
    await listGeminiModelsForContext({ command: agy, cacheScope: { ...scope("company-a"), cacheable: false } });
    expect(calls).toBe(2);
  });
});
