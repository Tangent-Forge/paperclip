import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

export async function testEnvironment(_ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  try {
    await execFileAsync("bash", ["--version"], { timeout: 5000 });
    checks.push({ code: "bash", level: "info", message: "bash found in PATH" });
  } catch {
    checks.push({
      code: "bash",
      level: "error",
      message: "bash not found in PATH",
      hint: "Required for janitor module scripts. Install bash or run in WSL.",
    });
  }

  try {
    const { stdout } = await execFileAsync("uname", ["-r"], { timeout: 5000 });
    const isWsl = stdout.toLowerCase().includes("microsoft") || stdout.toLowerCase().includes("wsl");
    if (isWsl) {
      checks.push({ code: "wsl", level: "info", message: "Running inside WSL" });
    } else {
      checks.push({
        code: "wsl",
        level: "warn",
        message: "Not running inside WSL",
        hint: "Janitor module scripts are WSL-native (Linux bash). Non-WSL environments may have limited support.",
      });
    }
  } catch {
    checks.push({
      code: "wsl",
      level: "warn",
      message: "Could not determine OS environment (uname failed)",
    });
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");

  return {
    adapterType: "janitor_local",
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
