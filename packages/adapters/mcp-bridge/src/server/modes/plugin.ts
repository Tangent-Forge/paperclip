import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { createScaffoldFailure } from "../shared.js";

export async function executePluginMode(_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return createScaffoldFailure("plugin");
}

export async function testPluginModeEnvironment(
  _ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: "mcp_bridge",
    status: "pass",
    testedAt: new Date().toISOString(),
    checks: [
      {
        code: "mcp_bridge_plugin_mode",
        level: "info",
        message: "Plugin bridge scaffold environment check passed.",
      },
    ],
  };
}
