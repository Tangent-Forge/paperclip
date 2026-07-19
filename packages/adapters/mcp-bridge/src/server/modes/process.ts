import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { createScaffoldFailure } from "../shared.js";

export async function executeProcessMode(_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return createScaffoldFailure("process");
}

export async function testProcessModeEnvironment(
  _ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: "mcp_bridge",
    status: "warn",
    testedAt: new Date().toISOString(),
    checks: [
      {
        code: "mcp_bridge_process_mode",
        level: "warn",
        message: "Process mode handler is present, but scaffold environment validation is not implemented yet.",
      },
    ],
  };
}
