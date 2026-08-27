import type { AdapterConfigSchema, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { listJanitorModules } from "./modules.js";
export { testEnvironment } from "./test.js";

export const type = "janitor_local";
export const label = "Janitor (local WSL)";

export const models = [
  { id: "ollama/qwen3:4b", label: "Qwen 3 4B (local)" },
  { id: "ollama/llama3.2:latest", label: "Llama 3.2 Latest (local)" },
  { id: "ollama/nomic-embed-text:latest", label: "Nomic Embed Text (local)" },
  { id: "lmo:auto", label: "LMO auto-route (via tangent-forge-lmo)" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Local-only",
    description: "Use the smallest local model for routine cleanup tasks. Zero cloud API cost.",
    adapterConfig: { model: "ollama/qwen3:4b" },
    source: "adapter_default",
  },
];

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "cwd",
        label: "Workspace root",
        type: "text",
        required: true,
        hint: "Absolute path to the workspace that Janitor may inspect.",
      },
      {
        key: "modules",
        label: "Audit module",
        type: "select",
        options: [
          { value: "workspace", label: "Workspace audit" },
          { value: "storage", label: "Storage scan" },
          { value: "security", label: "Security scan" },
          { value: "performance", label: "Performance checks" },
          { value: "dev_tools", label: "Development tools inventory" },
          { value: "review_knowledge", label: "Knowledge ingest review" },
        ],
        hint: "Leave unset to run every module. The standard form selects one module; raw configuration may provide an array.",
      },
      {
        key: "dryRun",
        label: "Read-only dry run",
        type: "toggle",
        default: true,
        hint: "Keep enabled for audits. Active mode requires a scoped board approval.",
      },
      {
        key: "approvalRequired",
        label: "Require board approval",
        type: "toggle",
        default: true,
        hint: "Active mode fails closed if this is disabled.",
      },
      {
        key: "reportDir",
        label: "Report directory",
        type: "text",
        hint: "Optional path inside the workspace. Defaults to .janitor/reports.",
      },
      {
        key: "maxStorageAgeDays",
        label: "Maximum storage age in days",
        type: "number",
        default: 90,
      },
      {
        key: "timeoutSec",
        label: "Module timeout in seconds",
        type: "number",
        default: 300,
      },
    ],
  };
}

export const agentConfigurationDoc = `# janitor_local agent configuration

Adapter: janitor_local

## Overview

Runs workspace audit, storage cleanup, and security scanning tasks locally via shell commands.
All scans are READ-ONLY by default. Write operations (delete, remediate) require explicit approval
gates configured in Paperclip before execution.

Source modules ported from:
  TANGENT_FORGE/tools/dev-audit-agent/modules/
  TANGENT_FORGE/tools/tangent-forge-repo-manager/ (secrets-registry scanner)

## Core fields

- cwd (string, required): absolute path to the workspace root to audit
- model (string, optional): local model id or "lmo:auto" for LMO routing
- lmoUrl (string, optional): base URL for tangent-forge-lmo if using lmo:auto (default: http://127.0.0.1:8000)
- modules (string or string[], optional): which audit modules to run — defaults to all
    choices: ["workspace", "storage", "security", "performance", "dev_tools", "review_knowledge"]
- reportDir (string, optional): where to write HTML/Markdown audit reports (default: {cwd}/.janitor/reports)
- dryRun (boolean, optional, default true): when true, no files are modified or deleted
- maxStorageAgeDays (number, optional): flag files older than N days in storage scan
- secretsPatterns (string[], optional): extra regex patterns for secrets scanner beyond defaults
- approvalRequired (boolean, optional, default true): must remain true; active mode fails closed if approval is disabled

## Operational fields

- timeoutSec (number, optional, default 300): scan timeout in seconds
- graceSec (number, optional, default 30): SIGTERM grace period

## Environment variables injected by Paperclip

PAPERCLIP_WORKSPACE_ROOT — resolved workspace root
PAPERCLIP_COMPANY_ID    — company scope
PAPERCLIP_RUN_ID        — current run id (for report naming)

## Notes

- This adapter shells out to the janitor module scripts in the adapter's modules/ directory.
- WSL paths are resolved automatically; Windows UNC paths (\\\\wsl.localhost\\...) are NOT accepted.
- When dryRun=false and approvalRequired=true (the recommended production config), the adapter
  will emit an approval request via the Paperclip control plane before any destructive operation.
`;
