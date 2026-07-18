import { describe, expect, it } from "vitest";
import { createServerAdapter, detectModel, execute, testEnvironment, type } from "../src/server/index.js";

const baseExecutionContext = {
  config: {},
  context: {},
};

const baseEnvironmentContext = {
  companyId: "company-1",
  adapterType: type,
  config: {},
};

describe("createServerAdapter", () => {
  it("exports the current Paperclip server adapter shape", () => {
    const adapter = createServerAdapter();
    expect(adapter).toMatchObject({
      type,
      models: [],
      agentConfigurationDoc: expect.stringContaining("Adapter: mcp_bridge"),
    });
    expect(adapter.execute).toBeTypeOf("function");
    expect(adapter.testEnvironment).toBeTypeOf("function");
    expect(adapter.detectModel).toBeTypeOf("function");
  });
});

describe("MCP bridge adapter scaffold", () => {
  it.each([
    ["process"],
    ["http"],
    ["plugin"],
  ])("returns a scaffold failure for %s mode", async (mode) => {
    const result = await execute({ ...baseExecutionContext, config: { mode } });
    expect(result).toMatchObject({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "mcp_bridge_not_implemented",
      errorMessage: expect.stringContaining(`${mode} mode`),
      resultJson: { mode, implemented: false },
      summary: expect.stringContaining(`${mode} mode`),
    });
  });

  it("defaults omitted mode to safe process mode", async () => {
    const result = await execute({ ...baseExecutionContext, config: {} });
    expect(result.errorCode).toBe("mcp_bridge_not_implemented");
    expect(result.errorMessage).toContain("process mode");
  });

  it("rejects explicit unsupported execution modes", async () => {
    const result = await execute({ ...baseExecutionContext, config: { mode: "mystery" } });
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "mcp_bridge_invalid_mode",
      errorMessage: 'MCP bridge scaffold received unsupported mode "mystery".',
      resultJson: { mode: "mystery", implemented: false, validModes: ["http", "plugin", "process"] },
      summary: 'MCP bridge scaffold received unsupported mode "mystery".',
    });
  });

  it.each([
    ["process"],
    ["http"],
    ["plugin"],
  ])("returns a valid environment test result for %s mode", async (mode) => {
    const result = await testEnvironment({ ...baseEnvironmentContext, config: { mode } });
    expect(result).toMatchObject({
      adapterType: type,
      status: "pass",
      checks: expect.any(Array),
    });
    expect(result.checks[0]?.code).toContain(mode);
  });

  it("defaults omitted mode to safe process environment checks", async () => {
    const result = await testEnvironment({ ...baseEnvironmentContext, config: {} });
    expect(result.status).toBe("pass");
    expect(result.checks[0]?.code).toContain("process");
  });

  it("fails explicit unsupported environment modes", async () => {
    const result = await testEnvironment({ ...baseEnvironmentContext, config: { mode: "unknown" } });
    expect(result.status).toBe("fail");
    expect(result.checks[0]).toMatchObject({
      code: "mcp_bridge_invalid_mode",
      level: "error",
    });
  });

  it("detectModel is intentionally a scaffold noop", async () => {
    await expect(detectModel()).resolves.toBeNull();
  });
});
