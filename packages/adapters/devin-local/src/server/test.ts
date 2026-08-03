import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { ensureAdapterExecutionTargetCommandResolvable, ensureAdapterExecutionTargetDirectory, resolveAdapterExecutionTargetCwd, runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { listDevinModels } from "./models.js";

function status(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const command = asString(config.command, "devin");
  const cwd = resolveAdapterExecutionTargetCwd(ctx.executionTarget ?? null, asString(config.cwd, ""), process.cwd());
  const checks: AdapterEnvironmentCheck[] = [];
  const runId = `devin-envtest-${Date.now()}`;
  try {
    await ensureAdapterExecutionTargetDirectory(runId, ctx.executionTarget ?? null, cwd, { cwd, env: {}, createIfMissing: true });
    checks.push({ code: "devin_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (error) {
    checks.push({ code: "devin_cwd_invalid", level: "error", message: error instanceof Error ? error.message : "Invalid working directory" });
  }
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) if (typeof value === "string") env[key] = value;
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, ctx.executionTarget ?? null, cwd, runtimeEnv);
    checks.push({ code: "devin_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (error) {
    checks.push({ code: "devin_command_unresolvable", level: "error", message: error instanceof Error ? error.message : "Devin command is not executable" });
  }
  if (!checks.some((c) => c.level === "error")) {
    const models = await listDevinModels(true);
    if (models.length) checks.push({ code: "devin_models_discovered", level: "info", message: `Discovered ${models.length} Devin model(s).` });
    else checks.push({ code: "devin_models_unavailable", level: "warn", message: "Devin model discovery returned no models.", hint: "Run `devin auth status` and `devin models list --format json` on the Paperclip host." });
    const configured = asString(config.model, "").trim();
    if (configured) {
      const found = models.some((model) => model.id === configured);
      checks.push({ code: found ? "devin_model_configured" : "devin_model_not_found", level: found ? "info" : "warn", message: found ? `Configured model: ${configured}` : `Configured model "${configured}" was not found in Devin's live catalog.` });
    }
  }
  return { adapterType: ctx.adapterType, status: status(checks), checks, testedAt: new Date().toISOString() };
}
