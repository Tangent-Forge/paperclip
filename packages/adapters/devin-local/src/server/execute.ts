import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, buildPaperclipEnv, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, ensureAbsoluteDirectory, joinPromptSections, parseObject, renderTemplate } from "@paperclipai/adapter-utils/server-utils";
import { readAdapterExecutionTarget, runAdapterExecutionTargetProcess, resolveAdapterExecutionTargetTimeoutSec } from "@paperclipai/adapter-utils/execution-target";
import { models } from "../index.js";

function firstLine(value: string): string { return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ""; }

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, agent, context, runId, onLog, onMeta, onSpawn } = ctx;
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget, legacyRemoteExecution: ctx.executionTransport?.remoteExecution });
  const cwd = asString(config.cwd, process.cwd()).trim() || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  // Restores the override dropped in e8af4ed4 ("activate Devin adapter"). The
  // systemd user PATH does not include ~/.local/bin, where the Devin CLI installs,
  // so a bare "devin" fails with ENOENT under the supervised service.
  const command = asString(config.command, "devin").trim() || "devin";
  const model = asString(config.model, "").trim();
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(target, asNumber(config.timeoutSec, 900));
  const template = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const prompt = joinPromptSections([renderTemplate(template, { agentId: agent.id, companyId: agent.companyId, runId, agent, context })]);
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
  for (const [key, value] of Object.entries(envConfig)) if (typeof value === "string") env[key] = value;
  // Devin's permission modes: "auto" (default) auto-approves read-only tools only,
  // "accept-edits" adds workspace edits, "smart" adds fast-model-judged actions,
  // "dangerous" auto-approves everything. Paperclip's generated prompt instructs
  // agents to run shell commands (curl against the Paperclip API), so anything
  // below full auto-approve stalls on a prompt that --print mode cannot render.
  // Matches the unattended posture of the sibling adapters (gemini passes
  // --dangerously-skip-permissions). Tighten via config for hardened lanes.
  const permissionMode = asString(config.permissionMode, "dangerous").trim() || "dangerous";
  // Trust defaults to true in every mode, and print mode cannot show the trust
  // prompt — it just fails in an untrusted directory. Paperclip runs an
  // operator-approved cwd, so skip the check unless explicitly re-enabled.
  const respectWorkspaceTrust = config.respectWorkspaceTrust === true;
  const sandbox = config.sandbox === true;

  const flags = [
    "--print",
    "--permission-mode", permissionMode,
    ...(respectWorkspaceTrust ? [] : ["--respect-workspace-trust", "false"]),
    ...(model ? ["--model", model] : []),
    ...(sandbox ? ["--sandbox"] : []),
  ];
  // "--" terminates option parsing. Without it a prompt beginning with "-" is
  // parsed as flags, and --print's optional inline value can swallow the prompt.
  const args = [...flags, "--", prompt];
  await onMeta?.({ adapterType: "devin_local", command, cwd, commandArgs: [...flags, "--", `<prompt ${prompt.length} chars>`], env, prompt, context });
  const proc = await runAdapterExecutionTargetProcess(runId, target, command, args, { cwd, env, timeoutSec, graceSec: 15, onSpawn, onLog });
  const failed = (proc.exitCode ?? 0) !== 0;
  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage: proc.timedOut ? `Timed out after ${timeoutSec}s` : failed ? firstLine(proc.stderr) || `Devin exited with code ${proc.exitCode ?? -1}` : null,
    provider: "devin",
    model: model || null,
    summary: proc.stdout.trim() || null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    costUsd: null,
    resultJson: failed ? { stderr: proc.stderr } : undefined,
  };
}
