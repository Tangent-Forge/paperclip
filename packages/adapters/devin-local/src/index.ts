import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "devin_local";
export const label = "Devin (local)";
export const models: AdapterModel[] = [];

export const agentConfigurationDoc = `# devin_local agent configuration

Runs the official Devin CLI installed and authenticated on the Paperclip host.

Core fields:
- command: Devin executable, default \`devin\`
- model: account-entitled Devin model ID; discovered from \`devin models list --format json\`
- cwd: absolute working directory
- promptTemplate: optional Paperclip prompt template
- timeoutSec: process timeout in seconds
- env: optional environment overrides

This adapter uses Devin CLI transport only. It does not read Devin Desktop credentials or call undocumented Devin APIs.
`;

export { createServerAdapter } from "./server/index.js";
