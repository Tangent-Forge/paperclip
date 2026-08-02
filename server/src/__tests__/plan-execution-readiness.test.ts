import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkIssuePlanExecutionReadiness } from "../services/plan-execution-readiness.js";

const checkerRoot = "/home/tfhub/tangent-forge/repos/agent-systems-hub/.claude/worktrees/plan-execution-readiness-standard";

function fakeDb(description: string) {
  let selectCount = 0;
  return {
    select() {
      const rows = selectCount++ === 0
        ? [{ description }]
        : [{
            id: "codex-home-id",
            name: "codex-home",
            status: "idle",
            adapterType: "codex_local",
            runtimeConfig: { heartbeat: { enabled: false } },
          }];
      return {
        from() {
          return this;
        },
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

describe("plan execution readiness integration", () => {
  it("does not inspect ordinary issues without an explicit manifest", async () => {
    const result = await checkIssuePlanExecutionReadiness(fakeDb("ordinary issue") as never, "company", "issue");
    expect(result).toBeNull();
  });

  it("reports malformed opt-in manifests as blocked without suppressing dispatch", async () => {
    const description = "<!-- SR-PLAN-EXECUTION-READINESS-v1\nnot-json\n-->";
    const result = await checkIssuePlanExecutionReadiness(fakeDb(description) as never, "company", "issue");
    expect(result).toMatchObject({ verdict: "BLOCKED", checker: "parser" });
    expect(result?.findings.map((finding) => finding.code)).toEqual(["manifest_invalid"]);
  });

  it.skipIf(!existsSync(checkerRoot))("runs the canonical checker for a valid manifest", async () => {
    const manifest = {
      tasks: [{
        id: "canary-1",
        title: "Readiness canary",
        description: "read-only validation",
        assignee: "codex-home",
        budget: { class: "direct", available_worker_slots: 0 },
        dependencies: [],
        blockedByIssueIds: [],
        required_adapter: "codex_local",
      }],
    };
    const description = `<!-- SR-PLAN-EXECUTION-READINESS-v1\n${JSON.stringify(manifest)}\n-->`;
    const result = await checkIssuePlanExecutionReadiness(fakeDb(description) as never, "company", "issue");
    expect(result).toMatchObject({ verdict: "PASS", checker: `${checkerRoot}/scripts/plan_execution_readiness.py` });
  });
});
