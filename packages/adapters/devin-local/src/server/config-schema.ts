import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      { key: "model", label: "Devin model", type: "text", required: true, hint: "Use a model ID returned by Devin CLI discovery." },
      { key: "cwd", label: "Working directory", type: "text", hint: "Absolute directory for Devin." },
      { key: "command", label: "Command", type: "text", default: "devin", hint: "Absolute path is recommended — the systemd user PATH does not include ~/.local/bin." },
      {
        key: "permissionMode",
        label: "Permission mode",
        type: "select",
        default: "dangerous",
        options: [
          { label: "Dangerous — auto-approve all tools (required for unattended runs)", value: "dangerous" },
          { label: "Smart — auto-run actions a fast model judges safe", value: "smart" },
          { label: "Accept edits — auto-approve workspace edits", value: "accept-edits" },
          { label: "Auto — auto-approve read-only tools only", value: "auto" },
        ],
        hint: "Below 'dangerous', unattended runs stall on approval prompts that --print mode cannot render.",
      },
      { key: "respectWorkspaceTrust", label: "Respect workspace trust", type: "toggle", default: false, hint: "Leave off for unattended runs; --print mode fails outright in an untrusted directory." },
      { key: "sandbox", label: "Sandbox exec tools", type: "toggle", default: false, hint: "Research preview: bwrap+seccomp on Linux." },
      { key: "timeoutSec", label: "Timeout seconds", type: "number", default: 900 },
      { key: "env", label: "Environment JSON", type: "textarea" },
    ],
  };
}
