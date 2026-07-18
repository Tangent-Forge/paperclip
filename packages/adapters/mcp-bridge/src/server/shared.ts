import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export type BridgeMode = "http" | "plugin" | "process";

export function readBridgeMode(config: Record<string, unknown>): BridgeMode {
  const rawMode = typeof config.mode === "string" ? config.mode.trim().toLowerCase() : "";
  if (rawMode === "http" || rawMode === "plugin" || rawMode === "process") {
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

export function createScaffoldDetectModel() {
  return Promise.resolve(null);
}
