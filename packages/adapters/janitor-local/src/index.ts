import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

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
- modules (string[], optional): which audit modules to run — defaults to all
    choices: ["workspace", "storage", "security", "performance", "dev_tools"]
- reportDir (string, optional): where to write HTML/Markdown audit reports (default: {cwd}/.janitor/reports)
- dryRun (boolean, optional, default true): when true, no files are modified or deleted
- maxStorageAgeDays (number, optional): flag files older than N days in storage scan
- secretsPatterns (string[], optional): extra regex patterns for secrets scanner beyond defaults
- approvalRequired (boolean, optional, default true): gate any write/delete actions behind Paperclip approval

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
