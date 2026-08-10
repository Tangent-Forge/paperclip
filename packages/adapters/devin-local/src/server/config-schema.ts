import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      { key: "model", label: "Devin model", type: "text", required: true, hint: "Use a model ID returned by Devin CLI discovery." },
      { key: "cwd", label: "Working directory", type: "text", hint: "Absolute directory for Devin." },
      { key: "command", label: "Command", type: "text", default: "devin" },
      { key: "timeoutSec", label: "Timeout seconds", type: "number", default: 900 },
      { key: "env", label: "Environment JSON", type: "textarea" },
    ],
  };
}
