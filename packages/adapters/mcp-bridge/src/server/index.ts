import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { executeHttpMode, testHttpModeEnvironment } from "./modes/http.js";
import { executePluginMode, testPluginModeEnvironment } from "./modes/plugin.js";
import { executeProcessMode, testProcessModeEnvironment } from "./modes/process.js";
import {
  createInvalidModeEnvironmentResult,
  createInvalidModeFailure,
  createScaffoldDetectModel,
  isBridgeMode,
  readBridgeMode,
} from "./shared.js";

export const type = "mcp_bridge";
export const label = "Paperclip MCP Bridge";

export const models: AdapterModel[] = [];

export const agentConfigurationDoc = `# mcp_bridge agent configuration

Adapter: mcp_bridge

Use when:
- You want Paperclip to bridge into an existing MCP-compatible target
- You want a single adapter package that can later grow HTTP, plugin, and process execution paths

Core fields:
- mode (string, optional): http | plugin | process. Defaults to process.
- httpUrl (string, optional): target URL used by http mode
- pluginName (string, optional): external plugin identifier used by plugin mode
- command (string, optional): command used by process mode
- args (string[], optional): extra command arguments for process mode
- env (object, optional): KEY=VALUE environment variables
- cwd (string, optional): working directory for process mode
- timeoutSec (number, optional): execution timeout in seconds

Notes:
- This package is currently a scaffold.
- The mode-specific executors return explicit scaffold failures until the bridge logic is implemented.
- Environment checks return warn results for supported scaffold modes because validation is not implemented yet.
`;

function getModeName(config: Record<string, unknown>): "http" | "plugin" | "process" {
  return readBridgeMode(config);
}

function getExplicitMode(config: Record<string, unknown>): string | null {
  const rawMode = typeof config.mode === "string" ? config.mode.trim().toLowerCase() : "";
  return rawMode.length > 0 ? rawMode : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const explicitMode = getExplicitMode(ctx.config);
  if (explicitMode && !isBridgeMode(explicitMode)) {
    return createInvalidModeFailure(explicitMode);
  }

  switch (getModeName(ctx.config)) {
    case "http":
      return executeHttpMode(ctx);
    case "plugin":
      return executePluginMode(ctx);
    case "process":
    default:
      return executeProcessMode(ctx);
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const explicitMode = getExplicitMode(ctx.config);
  if (explicitMode && !isBridgeMode(explicitMode)) {
    return createInvalidModeEnvironmentResult(explicitMode);
  }

  switch (getModeName(ctx.config)) {
    case "http":
      return testHttpModeEnvironment(ctx);
    case "plugin":
      return testPluginModeEnvironment(ctx);
    case "process":
    default:
      return testProcessModeEnvironment(ctx);
  }
}

export const detectModel = createScaffoldDetectModel;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    detectModel,
  };
}
