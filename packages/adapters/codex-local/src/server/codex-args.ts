import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  resolveCodexLocalModel,
} from "../index.js";

const SKIP_GIT_REPO_CHECK_FLAG = "--skip-git-repo-check";

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
};

function readExtraArgs(config: unknown): string[] {
  const fromExtraArgs = asStringArray(asRecord(config).extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(asRecord(config).args);
}

function sanitizeExtraArgs(extraArgs: string[], constrained: boolean): string[] {
  if (!constrained) {
    return extraArgs.filter((arg) => !arg.includes("dangerously-bypass-approvals-and-sandbox") && !arg.includes("dangerously-bypass-sandbox"));
  }
  const out: string[] = [];
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i] ?? "";
    if (arg.includes("dangerously-bypass-approvals-and-sandbox") || arg.includes("dangerously-bypass-sandbox")) continue;
    if (arg === "--search" || arg.startsWith("--search=")) continue;
    if (arg === "--sandbox" || arg.startsWith("--sandbox=")) {
      if (arg === "--sandbox" && extraArgs[i + 1] && !extraArgs[i + 1]!.startsWith("-")) i += 1;
      continue;
    }
    if (arg === "-c") {
      const next = extraArgs[i + 1] ?? "";
      if (/sandbox|shell_environment_policy|web_search|network/i.test(next)) {
        i += 1;
        continue;
      }
    }
    if (arg.startsWith("-c") && /sandbox|shell_environment_policy|web_search|network/i.test(arg)) continue;
    if (/^sandbox(_mode)?=/i.test(arg)) continue;
    out.push(arg);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatFastModeSupportedModels(): string {
  return `${CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ")} or manually configured model IDs`;
}

export function buildCodexExecArgs(
  config: unknown,
  options: {
    resumeSessionId?: string | null;
    skipGitRepoCheck?: boolean;
  } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  // Blank/whitespace model must not fall through to the CLI default.
  const model = resolveCodexLocalModel(asString(record.model, ""));
  const modelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const search = asBoolean(record.search, false);
  const fastModeRequested = asBoolean(record.fastMode, false);
  const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const bypass = asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const constraints = asRecord(record.executionConstraints);
  const networkDenied = asString(constraints.network, "") === "deny";
  const gitDenied = asString(constraints.gitMutation, "") === "deny";
  const profileStrict = asString(constraints.profile, "") === "canary_strict";
  const constrained = networkDenied || gitDenied || profileStrict;
  if (constrained && bypass) throw new Error("executionConstraints forbid Codex bypass flags");
  const sandboxMode = asString(constraints.sandboxMode, networkDenied || profileStrict ? "workspace-write" : "").trim();
  if ((networkDenied || profileStrict) && sandboxMode === "danger-full-access") {
    throw new Error("executionConstraints forbid danger-full-access sandbox");
  }
  const extraArgs = sanitizeExtraArgs(readExtraArgs(record), constrained);

  const args = ["exec", "--json"];
  // Codex rejects a repeated `--skip-git-repo-check` ("cannot be used multiple
  // times"). The adapter injects this flag for sandbox execution, so when an
  // operator's extraArgs already carry it the injection would abort the run
  // with exit code 2. Skip the injection in that case and let the operator's
  // copy stand.
  if (options.skipGitRepoCheck && !extraArgs.includes(SKIP_GIT_REPO_CHECK_FLAG)) {
    args.push(SKIP_GIT_REPO_CHECK_FLAG);
  }
  if (search && !networkDenied && !profileStrict) args.unshift("--search");
  if (networkDenied || profileStrict) {
    args.push("--sandbox", sandboxMode || "workspace-write", "-c", "shell_environment_policy.inherit=core");
  }
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) args.push("--model", model);
  if (modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
  }
  if (fastModeApplied) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId, "-");
  else args.push("-");

  return {
    args,
    model,
    fastModeRequested,
    fastModeApplied,
    fastModeIgnoredReason:
      fastModeRequested && !fastModeApplied
        ? `Configured fast mode is currently only supported on ${formatFastModeSupportedModels()}; Paperclip will ignore it for model ${model || "(default)"}.`
        : null,
  };
}
