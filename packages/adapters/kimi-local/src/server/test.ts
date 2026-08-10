import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_KIMI_LOCAL_MODEL } from "../index.js";
import { detectKimiAuthRequired } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "kimi");
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  const runtimeEnv: Record<string, string> = Object.fromEntries(
    Object.entries(ensurePathInEnv({
      ...process.env,
      ...env,
      PATH: `${process.env.HOME}/.kimi-code/bin:${process.env.PATH ?? ""}`,
    })).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  // command resolvable
  try {
    const probe = await runChildProcess(`kimi-envtest-${Date.now()}`, command, ["--version"], {
      cwd,
      env: runtimeEnv,
      timeoutSec: 20,
      graceSec: 5,
      onLog: async () => {},
    });
    if (probe.exitCode === 0 || (probe.stdout || "").trim()) {
      checks.push({
        code: "kimi_command_ok",
        level: "info",
        message: `Kimi CLI available: ${(probe.stdout || probe.stderr || "").trim().split("\n")[0]}`,
        detail: command,
      });
    } else {
      checks.push({
        code: "kimi_command_failed",
        level: "error",
        message: `Kimi CLI failed to run (${command})`,
        detail: (probe.stderr || probe.stdout || "").slice(0, 400),
        hint: "Install Kimi Code CLI and ensure command path is correct",
      });
    }
  } catch (err) {
    checks.push({
      code: "kimi_command_missing",
      level: "error",
      message: err instanceof Error ? err.message : "Kimi CLI not found",
      detail: command,
      hint: "Install from https://moonshotai.github.io/kimi-code/ or set command to absolute path e.g. /home/.../.kimi-code/bin/kimi",
    });
  }

  // doctor
  try {
    const doctor = await runChildProcess(`kimi-doctor-${Date.now()}`, command, ["doctor"], {
      cwd,
      env: runtimeEnv,
      timeoutSec: 30,
      graceSec: 5,
      onLog: async () => {},
    });
    const out = `${doctor.stdout}\n${doctor.stderr}`;
    if (detectKimiAuthRequired(out)) {
      checks.push({
        code: "kimi_auth_required",
        level: "error",
        message: "Kimi Code CLI is not authenticated",
        hint: "Run `kimi login` on this host (device-code OAuth). Do not use KIMI_API_KEY / Moonshot platform keys for this adapter.",
      });
    } else if (doctor.exitCode === 0) {
      checks.push({
        code: "kimi_doctor_ok",
        level: "info",
        message: "kimi doctor passed",
      });
    } else {
      checks.push({
        code: "kimi_doctor_warn",
        level: "warn",
        message: "kimi doctor returned non-zero",
        detail: out.slice(0, 400),
      });
    }
  } catch (err) {
    checks.push({
      code: "kimi_doctor_failed",
      level: "warn",
      message: err instanceof Error ? err.message : "kimi doctor failed",
    });
  }

  const model = asString(config.model, DEFAULT_KIMI_LOCAL_MODEL);
  checks.push({
    code: "kimi_model",
    level: "info",
    message: `Model: ${model || "(kimi default)"}`,
  });

  // discourage API key path
  if (runtimeEnv.KIMI_API_KEY) {
    checks.push({
      code: "kimi_api_key_present_unused",
      level: "info",
      message: "KIMI_API_KEY is present in the environment but kimi_local uses OAuth subscription credentials, not the platform API key",
    });
  }

  const configPath = path.join(process.env.HOME || "", ".kimi-code", "config.toml");
  checks.push({
    code: "kimi_config_path",
    level: "info",
    message: `Expected config at ${configPath}`,
  });

  return {
    adapterType: "kimi_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
