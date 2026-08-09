import type { AdapterExecutionContext, AdapterExecutionResult } from "./types.js";
import {
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensurePathInEnv,
  parseObject,
  resolveCommandForLogs,
  runChildProcess,
} from "./utils.js";
import type { AgentIdentityProofContext } from "../services/agent-identity-proof.js";

const PROOF_PREFIX = "PAPERCLIP_IDENTITY_PROOF_JSON=";

function configString(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseReceipt(stdout: string): Record<string, unknown> | null {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(PROOF_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(PROOF_PREFIX.length));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function executeHermesIdentityProof(
  ctx: AdapterExecutionContext,
  proof: AgentIdentityProofContext,
): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.agent.adapterConfig);
  const command = configString(config, "hermesCommand", "hermes");
  const apiUrl = configString(config, "paperclipApiUrl", process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api");
  const cwd = configString(config, "cwd", process.cwd());
  const timeoutSec = configNumber(config, "timeoutSec", 60);
  const graceSec = configNumber(config, "graceSec", 15);
  const envBindings = parseObject(config.env);
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const env: Record<string, string> = {
    ...inheritedEnv,
    ...buildPaperclipEnv(ctx.agent),
  };
  for (const [key, value] of Object.entries(envBindings)) {
    if (typeof value === "string") env[key] = value;
  }
  env.PAPERCLIP_RUN_ID = ctx.runId;
  env.PAPERCLIP_TASK_ID = proof.issueId;
  delete env.PAPERCLIP_AGENT_JWT_SECRET;
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const args = [
    "paperclip-identity-probe",
    "--api-url", apiUrl,
    "--expected-agent-id", proof.expectedAgentId,
    "--expected-issue-id", proof.issueId,
    "--expected-issue-identifier", proof.issueIdentifier,
  ];
  await ctx.onMeta?.({
    adapterType: "hermes_local_identity_proof",
    command: resolvedCommand,
    cwd,
    commandArgs: args,
    env: buildInvocationEnvForLogs(env, { runtimeEnv, includeRuntimeKeys: ["HOME"], resolvedCommand }),
  });
  const result = await runChildProcess(ctx.runId, command, args, {
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog: ctx.onLog,
  });
  const receipt = parseReceipt(result.stdout);
  const resultJson = { identityProof: receipt };
  if (result.timedOut) {
    return { exitCode: result.exitCode, signal: result.signal, timedOut: true, clearSession: true, resultJson };
  }
  if ((result.exitCode ?? 0) !== 0) {
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: false,
      clearSession: true,
      errorMessage: "Hermes identity probe exited unsuccessfully",
      errorCode: "identity_probe_execution_failed",
      resultJson,
    };
  }
  if (!receipt) {
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: false,
      clearSession: true,
      errorMessage: "Hermes identity probe did not emit a structured receipt",
      errorCode: "identity_probe_receipt_missing",
      resultJson,
    };
  }
  return { exitCode: result.exitCode, signal: result.signal, timedOut: false, clearSession: true, resultJson };
}
