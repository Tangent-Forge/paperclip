export const type = "janitor_local";
export const label = "Janitor (local WSL)";

export function parseConfig(raw: Record<string, unknown>) {
  return raw;
}

export const configSchema = {
  type: "object",
  properties: {
    cwd: { type: "string", title: "Workspace root", description: "Absolute path to audit" },
    modules: {
      type: "array",
      items: { type: "string", enum: ["workspace", "storage", "security", "performance", "dev_tools"] },
      title: "Modules",
      description: "Which audit modules to run (empty = all)",
    },
    dryRun: { type: "boolean", title: "Dry run", default: true, description: "Read-only — no files modified" },
    approvalRequired: { type: "boolean", title: "Require approval for writes", default: true },
    model: { type: "string", title: "Model", description: "Local model id or lmo:auto" },
    lmoUrl: { type: "string", title: "LMO URL", description: "URL for tangent-forge-lmo (if using lmo:auto)" },
    reportDir: { type: "string", title: "Report directory" },
    maxStorageAgeDays: { type: "number", title: "Max storage age (days)" },
    timeoutSec: { type: "number", title: "Timeout (seconds)", default: 300 },
  },
};
