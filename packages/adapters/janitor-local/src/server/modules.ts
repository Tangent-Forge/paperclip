import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export type JanitorModuleId = "workspace" | "storage" | "security" | "performance" | "dev_tools" | "review_knowledge";

export interface JanitorModuleResult {
  module: JanitorModuleId;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface JanitorModuleEntry {
  id: JanitorModuleId;
  label: string;
  description: string;
  scriptName: string;
}

export const JANITOR_MODULES: JanitorModuleEntry[] = [
  {
    id: "workspace",
    label: "Workspace Audit",
    description: "Scans git repos, VS Code extensions, and dev tool configuration",
    scriptName: "workspace_audit.sh",
  },
  {
    id: "storage",
    label: "Storage Cleanup Scan",
    description: "Identifies large files, old build artifacts, and unused node_modules",
    scriptName: "storage_scan.sh",
  },
  {
    id: "security",
    label: "Security Scanner",
    description: "Detects exposed secrets, bad file permissions, and stale API key files",
    scriptName: "security_scan.sh",
  },
  {
    id: "performance",
    label: "Performance Checks",
    description: "Checks for common performance anti-patterns in the workspace",
    scriptName: "performance_checks.sh",
  },
  {
    id: "dev_tools",
    label: "Dev Tools Inventory",
    description: "Lists installed dev tools, their versions, and any known issues",
    scriptName: "dev_tools_inventory.sh",
  },
  {
    id: "review_knowledge",
    label: "Knowledge Ingest Reviewer",
    description: "Two-tier review of inbox files for the TF Brain vault — Haiku scoring with sensitive-data heuristics, routes to archive/quarantine/exceptions.",
    scriptName: "review_knowledge.sh",
  },
];

export function listJanitorModules(): JanitorModuleEntry[] {
  return JANITOR_MODULES;
}

export async function runJanitorModule(
  moduleId: JanitorModuleId,
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<JanitorModuleResult> {
  const entry = JANITOR_MODULES.find((m) => m.id === moduleId);
  if (!entry) {
    throw new Error(`Unknown janitor module: ${moduleId}`);
  }

  const scriptPath = path.join(__moduleDir, "..", "..", "modules", entry.scriptName);
  const start = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
      cwd,
      env: { ...process.env, ...env, JANITOR_CWD: cwd },
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { module: moduleId, exitCode: 0, stdout, stderr, durationMs: Date.now() - start };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      module: moduleId,
      exitCode: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(error),
      durationMs: Date.now() - start,
    };
  }
}
