import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

export type BridgeMode = "http" | "plugin" | "process";

export function readBridgeMode(config: Record<string, unknown>): BridgeMode {
  const rawMode = config.mode;
  if (rawMode === "http" || rawMode === "plugin" || rawMode === "process") {
    return rawMode;
  }
  return "process";
}

function stringifyConfigField(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createScaffoldResult(
  ctx: Pick<AdapterExecutionContext, "config" | "onLog">,
  mode: BridgeMode,
  detail: string,
): Promise<AdapterExecutionResult> {
  return ctx.onLog("stderr", `[paperclip-mcp-adapter] ${mode} mode is scaffold-only: ${detail}\n`).then(() => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: `paperclip-mcp-adapter ${mode} mode is scaffold-only`,
    errorCode: "MCP_BRIDGE_SCAFFOLD",
    errorFamily: "transient_upstream",
    summary: `Stubbed ${mode} mode invoked before bridge wiring was implemented.`,
    resultJson: {
      mode,
      detail,
      configPreview: {
        httpUrl: stringifyConfigField(ctx.config, "httpUrl"),
        pluginName: stringifyConfigField(ctx.config, "pluginName"),
        command: stringifyConfigField(ctx.config, "command"),
      },
    },
  }));
}

export function createScaffoldTestResult(
  adapterType: string,
  mode: BridgeMode,
  detail: string,
): AdapterEnvironmentTestResult {
  const checks: AdapterEnvironmentCheck[] = [
    {
      code: `scaffold-${mode}`,
      level: "warn",
      message: detail,
      detail: "The adapter package is registered and importable, but the mode-specific bridge is still a stub.",
    },
  ];

  return {
    adapterType,
    status: "warn",
    checks,
    testedAt: new Date().toISOString(),
  };
}

export function createScaffoldDetectModel() {
  return Promise.resolve(null);
}
