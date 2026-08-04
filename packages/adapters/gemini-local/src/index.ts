import {
  buildSandboxNpmInstallCommand,
  type AdapterModelProfileDefinition,
} from "@paperclipai/adapter-utils";

export const type = "gemini_local";
export const label = "Gemini / Antigravity CLI (local)";

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

export function resolveGeminiLocalModel(command: string, model: string): string | null {
  const commandName = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(cmd|exe)$/, "");
  if (commandName !== "agy") return model && model !== DEFAULT_GEMINI_LOCAL_MODEL ? model : null;

  const normalized = model.trim().replace(/^google\//i, "");
  if (!normalized || normalized === DEFAULT_GEMINI_LOCAL_MODEL) return null;
  return AGY_MODEL_ALIASES[normalized] ?? normalized;
}

export function sanitizeGeminiLocalExtraArgs(command: string, args: string[]): string[] {
  const commandName = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(cmd|exe)$/, "");
  if (commandName !== "agy") return args;

  const sanitized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--approval-mode" || arg === "--resume") {
      const nextArg = args[index + 1];
      if (nextArg && !nextArg.startsWith("-")) index += 1;
      continue;
    }
    if (
      arg === "--skip-trust" ||
      arg === "--sandbox=none" ||
      arg.startsWith("--skip-trust=") ||
      arg.startsWith("--sandbox=none=")
    ) continue;
    if (arg.startsWith("--approval-mode=") || arg.startsWith("--resume=")) continue;
    sanitized.push(arg);
  }
  return sanitized;
}

export const models = [
  { id: DEFAULT_GEMINI_LOCAL_MODEL, label: "Auto" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
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
- You want Gemini chat sessions resumed across heartbeats (Gemini CLI uses --resume; agy uses --conversation)
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
- sandbox (boolean, optional): run in sandbox mode (default: false; agy passes --sandbox only when enabled)
- command (string, optional): defaults to "gemini"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use positional prompt arguments, not stdin.
- Sessions resume with --resume for Gemini CLI or --conversation for agy when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.gemini/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication can use GOOGLE_API_KEY, Gemini CLI login, or Antigravity OAuth stored by agy. (GEMINI_API_KEY is deprecated.)
`;
