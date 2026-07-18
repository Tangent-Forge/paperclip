import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { createScaffoldFailure } from "../shared.js";

export async function executeHttpMode(_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return createScaffoldFailure("http");
}

export async function testHttpModeEnvironment(
  _ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: "mcp_bridge",
    status: "pass",
    testedAt: new Date().toISOString(),
    checks: [
      {
        code: "mcp_bridge_http_mode",
        level: "info",
        message: "HTTP bridge scaffold environment check passed.",
      },
    ],
  };
}
