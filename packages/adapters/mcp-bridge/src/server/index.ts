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
- process mode fields:
  - command (string, required): executable path only; no shell string parsing
  - args (string[], optional): extra command arguments passed literally
  - env (object, optional): string-to-string environment overrides merged onto a safe inherited environment
  - cwd (string, optional): working directory for the spawned process
  - timeoutSec (number, optional): positive timeout in seconds, default 60, max 3600
  - toolName (string, required): the single MCP tool Paperclip will call
  - toolArguments (object, optional): extra JSON arguments merged into the tool call
  - contextArgument (string, optional): argument name that receives the Paperclip task context, default "context"

Process mode behavior:
- Paperclip connects to the target over stdio using the MCP SDK.
- Paperclip makes exactly one MCP tool call per execution.
- The tool call includes a size-bounded, defense-in-depth-redacted task payload: runId, minimal agent/runtime identifiers, and only approved task-context fields. Adapter config, auth/session data, secret manifests, workspace internals, and unknown context keys are excluded.
- stderr is relayed as adapter stderr logs and is never treated as protocol stdout.
- The adapter returns bounded/redacted MCP content and structured content on success, preserves MCP tool errors, and marks timeouts explicitly. Redaction is defense in depth, not a substitute for governing the configured target.
- Invalid or unknown config shapes fail closed before any spawn attempt.

Notes:
- HTTP and plugin modes remain scaffolded for now.
- Environment checks for process mode validate config shape only; live target probing happens at execution time.
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
