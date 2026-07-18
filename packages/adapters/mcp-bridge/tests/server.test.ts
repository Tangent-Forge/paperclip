import { describe, expect, it } from "vitest";
import { createServerAdapter, detectModel, execute, testEnvironment, type } from "../src/server/index.js";

const baseExecutionContext = {
  config: {},
  context: {},
} as any;

const baseEnvironmentContext = {
  companyId: "company-1",
  adapterType: type,
  config: {},
} as any;

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
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "mcp_bridge_not_implemented",
    });
    expect(result.errorMessage).toBeUndefined();
    expect(result.output).toContain(`${mode} mode`);
  });

  it("defaults unknown modes to safe process mode", async () => {
    const result = await execute({ ...baseExecutionContext, config: { mode: "mystery" } });
    expect(result.output).toContain("process mode");
    expect(result.errorCode).toBe("mcp_bridge_not_implemented");
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
    expect(result.checks[0]?.code).toContain("bridge_mode");
  });

  it("defaults unknown modes to safe process environment checks", async () => {
    const result = await testEnvironment({ ...baseEnvironmentContext, config: { mode: "unknown" } });
    expect(result.checks[0]?.code).toContain("process");
  });

  it("detectModel is intentionally a scaffold noop", async () => {
    await expect(detectModel()).resolves.toBeNull();
  });
});
