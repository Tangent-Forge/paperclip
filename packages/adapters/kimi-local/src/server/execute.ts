import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  runChildProcess,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_KIMI_LOCAL_MODEL } from "../index.js";
import {
  detectKimiAuthRequired,
  isKimiUnknownSessionError,
  parseKimiStreamJson,
} from "./parse.js";

function readNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "kimi");
  const model = asString(config.model, DEFAULT_KIMI_LOCAL_MODEL).trim();
  const auto = asBoolean(config.auto, true);
  const yolo = asBoolean(config.yolo, true);
  const extraArgs = asStringArray(config.extraArgs) ?? [];

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim() ? context.wakeReason.trim() : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;

  const home = process.env.HOME || "";
  const runtimeEnv: Record<string, string> = Object.fromEntries(
    Object.entries(ensurePathInEnv({
      ...process.env,
      ...env,
      PATH: `${home}/.kimi-code/bin:${home}/.local/bin:${process.env.PATH ?? ""}`,
    })).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  const runtimeSessionId =
    readNonEmptyString(runtime.sessionParams?.sessionId) || readNonEmptyString(runtime.sessionId);
  const runtimeSessionCwd = readNonEmptyString(runtime.sessionParams?.cwd);
  const canResume =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResume ? runtimeSessionId : null;

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(sessionId),
  });
  const renderedPrompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    agent,
    context,
  });
  // joinPromptSections expects an array of sections (not variadic strings).
  const prompt = joinPromptSections([wakePrompt, renderedPrompt]);

  const buildArgs = (resumeId: string | null): string[] => {
    // kimi rejects combining -p/--prompt with both -y/--yolo and --auto.
    // Non-interactive Paperclip runs use -p only; do not pass permission flags.
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (model) args.push("-m", model);
    if (resumeId) args.push("-S", resumeId);
    // Filter any accidental permission flags from extraArgs when using -p.
    const blocked = new Set(["-y", "--yolo", "--auto"]);
    for (const arg of extraArgs) {
      if (!blocked.has(arg)) args.push(arg);
    }
    return args;
  };

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  await onMeta?.({
    adapterType: "kimi_local",
    command,
    cwd,
    context: { model: model || null, sessionId },
  });

  await onLog(
    "stdout",
    `[kimi] Starting Kimi Code CLI (model=${model || "configured-default"}, session=${sessionId ?? "new"})\n`,
  );

  const runAttempt = async (resumeId: string | null) => {
    const args = buildArgs(resumeId);
    return runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
  };

  let proc = await runAttempt(sessionId);
  let parsed = parseKimiStreamJson(proc.stdout || "");
  const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;

  if (
    sessionId &&
    !proc.timedOut &&
    (proc.exitCode ?? 1) !== 0 &&
    isKimiUnknownSessionError(combined)
  ) {
    await onLog("stdout", "[kimi] Stored session invalid; retrying with a fresh session\n");
    proc = await runAttempt(null);
    parsed = parseKimiStreamJson(proc.stdout || "");
    return toResult(proc, parsed, cwd, model, { clearSession: true });
  }

  // Only treat as auth failure when the process actually failed — never scan
  // successful assistant narrative for auth keywords.
  const processFailed = proc.timedOut || (proc.exitCode ?? 1) !== 0;
  const authProbe = `${proc.stderr || ""}\n${parsed.errorMessage || ""}`;
  if (processFailed && (detectKimiAuthRequired(authProbe) || detectKimiAuthRequired((proc.stdout || "").slice(0, 1500)))) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      errorMessage: "Kimi Code CLI is not authenticated. Run `kimi login` on the host.",
      errorCode: "AUTH_REQUIRED",
      provider: "kimi-code",
      model: model || null,
      clearSession: false,
    };
  }

  return toResult(proc, parsed, cwd, model, { clearSession: false });
}

function toResult(
  proc: Awaited<ReturnType<typeof runChildProcess>>,
  parsed: ReturnType<typeof parseKimiStreamJson>,
  cwd: string,
  model: string,
  opts: { clearSession: boolean },
): AdapterExecutionResult {
  const failed = proc.timedOut || (proc.exitCode ?? 1) !== 0;
  const errorMessage =
    parsed.errorMessage ||
    (failed ? (proc.stderr || proc.stdout || "Kimi CLI failed").slice(0, 2000) : null);

  const result: AdapterExecutionResult = {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    provider: "kimi-code",
    model: model || null,
    summary: parsed.summary,
    errorMessage: failed ? errorMessage : null,
    resultJson: {
      result: parsed.summary,
      session_id: parsed.sessionId,
    },
    clearSession: opts.clearSession,
  };

  if (parsed.sessionId) {
    result.sessionParams = { sessionId: parsed.sessionId, cwd };
    result.sessionDisplayId = parsed.sessionId.slice(0, 24);
  }

  return result;
}
