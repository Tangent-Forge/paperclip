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
import { DEFAULT_QWEN_LOCAL_MODEL } from "../index.js";
import { detectQwenAuthRequired } from "./parse.js";

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
  const command = asString(config.command, "qwen");
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  const home = process.env.HOME || "";
  const runtimeEnv: Record<string, string> = Object.fromEntries(
    Object.entries(ensurePathInEnv({
      ...process.env,
      ...env,
      PATH: `${home}/.nvm/versions/node/v26.4.0/bin:${home}/.local/bin:${process.env.PATH ?? ""}`,
    })).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  try {
    const probe = await runChildProcess(`qwen-envtest-${Date.now()}`, command, ["--version"], {
      cwd,
      env: runtimeEnv,
      timeoutSec: 20,
      graceSec: 5,
      onLog: async () => {},
    });
    const ver = (probe.stdout || probe.stderr || "").trim().split("\n")[0];
    if (probe.exitCode === 0 || ver) {
      checks.push({
        code: "qwen_command_ok",
        level: "info",
        message: `Qwen CLI available: ${ver || "ok"}`,
        detail: command,
      });
    } else {
      checks.push({
        code: "qwen_command_failed",
        level: "error",
        message: "Qwen CLI failed to run",
        detail: (probe.stderr || "").slice(0, 400),
        hint: "npm install -g @qwen-code/qwen-code@latest",
      });
    }
  } catch (err) {
    checks.push({
      code: "qwen_command_missing",
      level: "error",
      message: err instanceof Error ? err.message : "Qwen CLI not found",
      hint: "Install with: npm install -g @qwen-code/qwen-code@latest",
    });
  }

  const tokenPlanKey = runtimeEnv.BAILIAN_TOKEN_PLAN_API_KEY;
  const codingPlanKey = runtimeEnv.BAILIAN_CODING_PLAN_API_KEY;
  if (tokenPlanKey && tokenPlanKey.trim()) {
    checks.push({
      code: "qwen_token_plan_key",
      level: "info",
      message: "BAILIAN_TOKEN_PLAN_API_KEY is set (Token Plan)",
    });
  } else if (codingPlanKey && codingPlanKey.trim()) {
    checks.push({
      code: "qwen_coding_plan_key",
      level: "info",
      message: "BAILIAN_CODING_PLAN_API_KEY is set (Coding Plan)",
    });
  } else {
    checks.push({
      code: "qwen_auth_missing",
      level: "error",
      message: "No Qwen subscription key in environment",
      hint: "Set BAILIAN_TOKEN_PLAN_API_KEY (Token Plan, includes glm-5.2) or BAILIAN_CODING_PLAN_API_KEY in runtime.env, and configure ~/.qwen/settings.json (or run qwen then /auth).",
    });
  }

  // non-interactive probe
  try {
    const probe = await runChildProcess(
      `qwen-authprobe-${Date.now()}`,
      command,
      ["-p", "Reply exactly: PING", "-o", "text", "-m", asString(config.model, DEFAULT_QWEN_LOCAL_MODEL)],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: 45,
        graceSec: 5,
      onLog: async () => {},
      },
    );
    const out = `${probe.stdout}\n${probe.stderr}`;
    if (detectQwenAuthRequired(out)) {
      checks.push({
        code: "qwen_auth_not_selected",
        level: "error",
        message: "Qwen CLI reports no auth type selected",
        detail: out.slice(0, 300),
        hint: "Create ~/.qwen/settings.json with security.auth.selectedType=openai and Token Plan baseUrl/envKey, or run interactive /auth.",
      });
    } else if ((probe.exitCode ?? 1) === 0) {
      checks.push({
        code: "qwen_prompt_probe_ok",
        level: "info",
        message: "Non-interactive prompt probe succeeded",
      });
    } else {
      checks.push({
        code: "qwen_prompt_probe_failed",
        level: "warn",
        message: "Prompt probe failed",
        detail: out.slice(0, 400),
      });
    }
  } catch (err) {
    checks.push({
      code: "qwen_prompt_probe_error",
      level: "warn",
      message: err instanceof Error ? err.message : "probe error",
    });
  }

  checks.push({
    code: "qwen_model",
    level: "info",
    message: `Model: ${asString(config.model, DEFAULT_QWEN_LOCAL_MODEL)}`,
  });

  return {
    adapterType: "qwen_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
