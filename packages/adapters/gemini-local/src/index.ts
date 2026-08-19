import {
  buildSandboxNpmInstallCommand,
  type AdapterModelProfileDefinition,
} from "@paperclipai/adapter-utils";

export const type = "gemini_local";
export const label = "Gemini CLI / Antigravity";

export const SANDBOX_INSTALL_COMMAND = buildSandboxNpmInstallCommand("@google/gemini-cli");

export const DEFAULT_GEMINI_LOCAL_MODEL = "auto";

const AGY_MODEL_ALIASES: Record<string, string> = {
  "gemini-2.5-flash-lite": "gemini-3.5-flash-low",
  "gemini-2.5-flash": "gemini-3.5-flash-medium",
  "gemini-2.5-pro": "gemini-3.1-pro-low",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-low",
  "gemini-3-flash-preview": "gemini-3.5-flash-medium",
  "gemini-3.1-flash-lite": "gemini-3.5-flash-low",
};

export function isGeminiAntigravityCommand(command: string): boolean {
  const commandName = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(cmd|exe)$/, "");
  return commandName === "agy";
}

export function resolveGeminiLocalModel(command: string, model: string): string | null {
  if (!isGeminiAntigravityCommand(command)) return model && model !== DEFAULT_GEMINI_LOCAL_MODEL ? model : null;
  const normalized = model.trim().replace(/^google\//i, "");
  if (!normalized || normalized === DEFAULT_GEMINI_LOCAL_MODEL) return null;
  return AGY_MODEL_ALIASES[normalized] ?? normalized;
}

const AGY_VALUE_TAKING_OWNED_FLAGS = new Set([
  "--approval-mode",
  "--conversation",
  "--model",
  "--output-format",
  "--prompt",
  "--resume",
]);
const AGY_BOOLEAN_OWNED_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--sandbox",
  "--sandbox=none",
  "--skip-trust",
]);

export function sanitizeGeminiLocalExtraArgs(command: string, args: string[]): string[] {
  if (!isGeminiAntigravityCommand(command)) return args;
  const sanitized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const flag = arg.split("=", 1)[0];
    if (AGY_VALUE_TAKING_OWNED_FLAGS.has(arg)) {
      const nextArg = args[index + 1];
      if (nextArg && !nextArg.startsWith("-")) index += 1;
      continue;
    }
    if (AGY_VALUE_TAKING_OWNED_FLAGS.has(flag) || AGY_BOOLEAN_OWNED_FLAGS.has(arg) || AGY_BOOLEAN_OWNED_FLAGS.has(flag)) {
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}

export const models = [
  { id: DEFAULT_GEMINI_LOCAL_MODEL, label: "Auto" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3.1-pro-preview-customtools", label: "Gemini 3.1 Pro Preview (Custom Tools)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Gemini Flash Lite as the budget Gemini CLI lane while preserving the primary model.",
    adapterConfig: {
      model: "gemini-2.5-flash-lite",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# gemini_local agent configuration

Adapter: gemini_local

Use when:
- You want Paperclip to run the Gemini CLI locally on the host machine
- You want Gemini chat sessions resumed across heartbeats (--resume for Gemini CLI, --conversation for Antigravity)
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Gemini CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Gemini model id. Defaults to auto.
- engine (string, optional): leave unset/auto to use ACP when prerequisites pass and fall back to the Gemini CLI with diagnostics. Use "cli" to pin the CLI lane or "acp" to require ACP.
- sandbox (boolean, optional): run in sandbox mode (default: false, passes --sandbox=none)
- command (string, optional): defaults to "gemini"; set to "agy" for Antigravity OAuth/subscription execution
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- agentCommand (string, optional): ACP server command override used only when engine="acp"; defaults to gemini --acp
- mode (string, optional): ACP session mode when engine="acp"; persistent or oneshot
- nonInteractivePermissions (string, optional): ACP non-interactive permission fallback when engine="acp"; deny or fail
- stateDir (string, optional): ACP state directory override when engine="acp"
- warmHandleIdleMs (number, optional): warm ACP process idle timeout when engine="acp"; defaults to 0

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Gemini ACP is the preferred auto lane when Node >=20 and the local Gemini CLI command is available. It runs Gemini CLI's native \`gemini --acp\` server through Paperclip's shared ACP engine, including selected skill links, Paperclip runtime prompt/env guidance, model config, and persistent ACP session state. Auto selection falls back to the CLI lane when ACP prerequisites are unavailable; explicit engine="acp" fails loudly.
- Runs use --prompt for non-interactive execution, not stdin.
- The adapter sets a headless-safe terminal/browser environment for Gemini CLI child processes so unattended runs do not wait on browser auth or 256-color terminal prompts.
- Sessions resume with --resume when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.gemini/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication can use GEMINI_API_KEY / GOOGLE_API_KEY, local Gemini CLI login, or Antigravity OAuth stored by agy.
`;
