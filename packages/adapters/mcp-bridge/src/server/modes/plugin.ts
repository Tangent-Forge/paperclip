import type { AdapterEnvironmentTestContext, AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createScaffoldResult, createScaffoldTestResult } from "../shared.js";

export async function executePluginMode(ctx: AdapterExecutionContext) {
  return createScaffoldResult(
    ctx,
    "plugin",
    "Plugin transport is not wired yet.",
  );
}

export async function testPluginModeEnvironment(ctx: AdapterEnvironmentTestContext) {
  return createScaffoldTestResult(
    ctx.adapterType,
    "plugin",
    "Plugin mode is registered, but dynamic MCP plugin loading is still a stub.",
  );
}
