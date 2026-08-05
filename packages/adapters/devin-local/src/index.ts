import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "devin_local";
export const label = "Devin (local)";
export const models: AdapterModel[] = [];

export const agentConfigurationDoc = `# devin_local agent configuration

Runs the official Devin CLI installed and authenticated on the Paperclip host.

Core fields:
- command: Devin executable, default \`devin\`. Prefer an absolute path — the systemd
  user PATH does not include \`~/.local/bin\`, where the Devin CLI installs.
- model: account-entitled Devin model ID; discovered from \`devin models list --format json\`
- cwd: absolute working directory
- promptTemplate: optional Paperclip prompt template
- timeoutSec: process timeout in seconds
- env: optional environment overrides

Unattended execution fields:
- permissionMode: \`auto\` | \`accept-edits\` | \`smart\` | \`dangerous\` (default \`dangerous\`).
  Devin defaults to \`auto\`, which auto-approves read-only tools only. Paperclip's
  generated prompt tells agents to edit files and run shell commands, so anything
  below \`dangerous\` stalls on an approval prompt that \`--print\` mode cannot render.
- respectWorkspaceTrust: default \`false\`. Trust defaults to on in every mode, and
  \`--print\` cannot show the trust prompt — it fails outright in an untrusted
  directory. Set \`true\` only if the cwd has been trusted interactively.
- sandbox: default \`false\`. Research preview; bwrap+seccomp on Linux.

Runs pass the prompt after \`--\` so a prompt beginning with \`-\` is not parsed as
flags and \`--print\`'s optional inline value cannot swallow it.

This adapter uses Devin CLI transport only. It does not read Devin Desktop credentials or call undocumented Devin APIs.
`;

export { createServerAdapter } from "./server/index.js";
