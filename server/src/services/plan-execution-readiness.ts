import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";

const execFile = promisify(execFileCallback);
const READINESS_MARKER = "SR-PLAN-EXECUTION-READINESS-v1";
const CHECKER_RELATIVE_PATH = path.join("scripts", "plan_execution_readiness.py");
const POLICY_RELATIVE_PATH = path.join("standards", "plan-execution-readiness.boundaries.v1.json");
const DEFAULT_CHECKER_ROOTS = [
  "/home/tfhub/tangent-forge/repos/agent-systems-hub/.claude/worktrees/plan-execution-readiness-standard",
  "/home/tfhub/tangent-forge/repos/agent-systems-hub",
] as const;

type ReadinessFinding = Record<string, unknown>;

export interface PlanExecutionReadinessResult {
  standard: typeof READINESS_MARKER;
  verdict: "PASS" | "BLOCKED";
  findings: ReadinessFinding[];
  checkedAt: string;
  checker: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(description: string | null | undefined): Record<string, unknown> | "invalid" | null {
  if (!description) return null;
  const escapedMarker = READINESS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = description.match(
    new RegExp(`<!--\\s*${escapedMarker}\\s*\\n([\\s\\S]*?)\\n?\\s*-->`, "i"),
  );
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return isRecord(parsed) ? parsed : "invalid";
  } catch {
    return "invalid";
  }
}

async function findChecker(): Promise<{ checker: string; policy: string } | null> {
  const configuredRoot = process.env.PAPERCLIP_PLAN_READINESS_ROOT?.trim();
  const roots = configuredRoot ? [configuredRoot, ...DEFAULT_CHECKER_ROOTS] : [...DEFAULT_CHECKER_ROOTS];
  for (const root of roots) {
    const checker = path.join(root, CHECKER_RELATIVE_PATH);
    const policy = path.join(root, POLICY_RELATIVE_PATH);
    try {
      await Promise.all([fs.access(checker), fs.access(policy)]);
      return { checker, policy };
    } catch {
      // Ordinary Paperclip dispatch must not depend on a development checkout.
    }
  }
  return null;
}

function heartbeatPathAvailable(runtimeConfig: unknown): boolean {
  if (!isRecord(runtimeConfig)) return false;
  const heartbeat = isRecord(runtimeConfig.heartbeat) ? runtimeConfig.heartbeat : null;
  return Boolean(heartbeat && (heartbeat.enabled === true || heartbeat.path));
}

async function runChecker(
  checker: string,
  policy: string,
  plan: Record<string, unknown>,
  roster: Record<string, unknown>[],
): Promise<PlanExecutionReadinessResult> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-readiness-"));
  const planPath = path.join(tempRoot, "plan.json");
  const rosterPath = path.join(tempRoot, "roster.json");
  try {
    await fs.writeFile(planPath, JSON.stringify(plan), { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(rosterPath, JSON.stringify(roster), { encoding: "utf8", mode: 0o600 });
    try {
      const { stdout } = await execFile(
        "python3",
        [checker, "--plan", planPath, "--roster", rosterPath, "--policy", policy],
        { timeout: 15_000, maxBuffer: 1_000_000 },
      );
      const result = JSON.parse(stdout) as Partial<PlanExecutionReadinessResult>;
      return {
        standard: READINESS_MARKER,
        verdict: result.verdict === "PASS" ? "PASS" : "BLOCKED",
        findings: Array.isArray(result.findings) ? result.findings.filter(isRecord) : [],
        checkedAt: new Date().toISOString(),
        checker,
      };
    } catch (error) {
      const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
      try {
        const result = JSON.parse(stdout) as Partial<PlanExecutionReadinessResult>;
        return {
          standard: READINESS_MARKER,
          verdict: result.verdict === "PASS" ? "PASS" : "BLOCKED",
          findings: Array.isArray(result.findings) ? result.findings.filter(isRecord) : [],
          checkedAt: new Date().toISOString(),
          checker,
        };
      } catch {
        return {
          standard: READINESS_MARKER,
          verdict: "BLOCKED",
          findings: [{ code: "checker_failed", message: "Readiness checker did not return structured output." }],
          checkedAt: new Date().toISOString(),
          checker,
        };
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function checkIssuePlanExecutionReadiness(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<PlanExecutionReadinessResult | null> {
  const issue = await db
    .select({ description: issues.description })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  const plan = parseManifest(issue?.description);
  if (!plan) return null;
  if (plan === "invalid") {
    return {
      standard: READINESS_MARKER,
      verdict: "BLOCKED",
      findings: [{ code: "manifest_invalid", message: "The readiness manifest is not valid JSON." }],
      checkedAt: new Date().toISOString(),
      checker: "parser",
    };
  }

  const checkerLocation = await findChecker();
  if (!checkerLocation) {
    return {
      standard: READINESS_MARKER,
      verdict: "BLOCKED",
      findings: [{ code: "checker_unavailable", message: "The readiness checker is not installed on this host." }],
      checkedAt: new Date().toISOString(),
      checker: "unavailable",
    };
  }

  const rosterRows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      adapterType: agents.adapterType,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const roster = rosterRows.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    adapterType: agent.adapterType,
    heartbeatPathAvailable: heartbeatPathAvailable(agent.runtimeConfig),
  }));
  return runChecker(checkerLocation.checker, checkerLocation.policy, plan, roster);
}
