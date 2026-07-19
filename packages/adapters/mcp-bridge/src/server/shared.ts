import type { AdapterEnvironmentTestResult, AdapterExecutionResult } from "@paperclipai/adapter-utils";

export type BridgeMode = "http" | "plugin" | "process";

export function isBridgeMode(value: unknown): value is BridgeMode {
  return value === "http" || value === "plugin" || value === "process";
}

export function readBridgeMode(config: Record<string, unknown>): BridgeMode {
  const rawMode = typeof config.mode === "string" ? config.mode.trim().toLowerCase() : "";
  if (isBridgeMode(rawMode)) {
    return rawMode;
  }
  return "process";
}

export function createScaffoldFailure(mode: BridgeMode): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: `MCP bridge scaffold does not implement ${mode} mode yet.`,
    errorCode: "mcp_bridge_not_implemented",
    errorMeta: { mode, implemented: false },
    resultJson: { mode, implemented: false },
    summary: `MCP bridge scaffold does not implement ${mode} mode yet.`,
  };
}

export function createInvalidModeFailure(mode: string): AdapterExecutionResult {
  const summary = `MCP bridge scaffold received unsupported mode "${mode}".`;
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: summary,
    errorCode: "mcp_bridge_invalid_mode",
    errorMeta: { mode, implemented: false },
    resultJson: { mode, implemented: false, validModes: ["http", "plugin", "process"] },
    summary,
  };
}

export function createInvalidModeEnvironmentResult(mode: string): AdapterEnvironmentTestResult {
  return {
    adapterType: "mcp_bridge",
    status: "fail",
    testedAt: new Date().toISOString(),
    checks: [
      {
        code: "mcp_bridge_invalid_mode",
        level: "error",
        message: `Unsupported MCP bridge mode: ${mode}`,
      },
    ],
  };
}

export function createScaffoldDetectModel() {
  return Promise.resolve(null);
}
