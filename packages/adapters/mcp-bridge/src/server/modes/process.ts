import type { AdapterEnvironmentTestContext, AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createScaffoldResult, createScaffoldTestResult } from "../shared.js";

export async function executeProcessMode(ctx: AdapterExecutionContext) {
  return createScaffoldResult(
    ctx,
    "process",
    "Process transport is not wired yet.",
  );
}

export async function testProcessModeEnvironment(ctx: AdapterEnvironmentTestContext) {
  return createScaffoldTestResult(
    ctx.adapterType,
    "process",
    "Process mode is registered, but command execution is still a stub.",
  );
}
