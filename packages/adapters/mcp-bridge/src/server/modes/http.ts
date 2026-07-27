import type { AdapterEnvironmentTestContext, AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createScaffoldResult, createScaffoldTestResult } from "../shared.js";

export async function executeHttpMode(ctx: AdapterExecutionContext) {
  return createScaffoldResult(
    ctx,
    "http",
    "HTTP transport is not wired yet.",
  );
}

export async function testHttpModeEnvironment(ctx: AdapterEnvironmentTestContext) {
  return createScaffoldTestResult(
    ctx.adapterType,
    "http",
    "HTTP mode is registered, but its request/response bridge is still a stub.",
  );
}
