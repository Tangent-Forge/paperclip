import { describe, expect, it } from "vitest";
import { adapter, createServerAdapter, execute } from "./index.js";

describe("TF-007 worker adapter", () => {
  it("exports the external adapter factory and bounded type", () => {
    expect(createServerAdapter().type).toBe("tf_gpu_worker");
    expect(adapter.models).toEqual([]);
  });

  it("defaults to disabled and exposes the worker safety configuration", async () => {
    const schema = await Promise.resolve(adapter.getConfigSchema?.());
    expect(schema?.fields.some((field) => field.key === "enabled" && field.default === false)).toBe(true);
    expect(schema?.fields.some((field) => field.key === "fallbackPolicy" && field.default === "queue")).toBe(true);
  });

  it("short-circuits to policy_denied when the worker is disabled (no dispatch)", async () => {
    const res = await execute({
      runId: "disabled-check", config: { enabled: false }, context: {},
      onLog: async () => {},
    } as unknown as Parameters<typeof execute>[0]);
    expect(res.errorCode).toBe("policy_denied");
    expect((res.resultJson as { status?: string } | undefined)?.status).toBe("disabled");
  });
});

// TAN-798 acceptance: real staged canary through the adapter to live TF-007.
// Skipped by default (never touches the network in unit/CI runs); opt in with
// TAN798_LIVE_CANARY=1 on a host that can reach the worker. Proves the adapter
// builds a valid immutable job contract, dispatches it via the hub lane, and
// returns checksummed artifacts -- and that no secret-shaped content reaches logs.
const LIVE = process.env.TAN798_LIVE_CANARY === "1";
(LIVE ? describe : describe.skip)("TF-007 adapter live staged canary (TAN-798)", () => {
  it("dispatches a bounded job to TF-007 and returns a checksummed artifact", async () => {
    const stamp = `tan798-vitest-${Math.floor(Date.now() / 1000)}`;
    const logs: string[] = [];
    const res = await execute({
      runId: stamp,
      config: {
        enabled: true,
        hubScript: "/home/tfhub/.config/tangent-forge/agent-systems-hub/scripts/tf-worker-lane.py",
        jobClass: "light_cpu",
        job: {
          source_dir: "/home/tfhub/tangent-forge/pap2088-evidence-staging",
          command: "cp README.txt tan798.txt",
          artifacts: ["tan798.txt"],
          timeout_seconds: 60,
        },
        artifactDir: `/home/tfhub/artifacts/pap2088-acceptance-20260814/${stamp}`,
      },
      context: {},
      onLog: async (line: unknown) => { logs.push(typeof line === "string" ? line : JSON.stringify(line)); },
      onMeta: async () => {},
    } as unknown as Parameters<typeof execute>[0]);
    const result = (res.resultJson ?? {}) as { status?: string; artifacts?: Array<{ sha256?: string }> };
    expect(result.status).toBe("succeeded");
    expect(result.artifacts?.[0]?.sha256).toBeTruthy();
    expect(logs.join("\n")).not.toMatch(/(bearer\s|api[_-]?key\s*[=:]|password\s*[=:]|token\s*[=:])/i);
  }, 120_000);
});
