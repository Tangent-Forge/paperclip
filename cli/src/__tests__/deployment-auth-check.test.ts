import { describe, expect, it } from "vitest";
import { deploymentAuthCheck } from "../checks/deployment-auth-check.js";
import type { PaperclipConfig } from "../config/schema.js";

function baseConfig(overrides: Partial<PaperclipConfig["server"]> = {}): PaperclipConfig {
  return {
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      ...overrides,
    },
    auth: {
      baseUrlMode: "auto",
    },
  } as unknown as PaperclipConfig;
}

// PAP-1975 removed local_trusted's implicit board grant with no replacement
// session mechanism (by design — see
// doc/plans/2026-08-25-local-trusted-board-access-gap.md). Before this fix,
// `doctor` reported local_trusted as an unconditional "pass" even though its
// Board UI has had no working sign-in since that change — silently
// advertising a broken product surface as healthy. These pin the corrected,
// honest signal.
describe("deploymentAuthCheck: local_trusted", () => {
  it("warns (not passes) that the Board UI has no working sign-in, even with correct loopback binding", () => {
    const result = deploymentAuthCheck(baseConfig({ bind: "loopback" }));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Board UI");
    expect(result.message).toContain("403");
    expect(result.repairHint).toContain("authenticated");
    expect(result.repairHint).toContain("private");
  });

  it("still fails on the pre-existing, unrelated loopback-binding requirement", () => {
    const result = deploymentAuthCheck(baseConfig({ bind: "lan" }));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("loopback binding");
  });
});

describe("deploymentAuthCheck: authenticated mode is unaffected", () => {
  it("still passes for a correctly configured authenticated/private instance", () => {
    const original = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "test-secret";
    try {
      const result = deploymentAuthCheck(
        baseConfig({ deploymentMode: "authenticated", exposure: "private", bind: "loopback" }),
      );
      expect(result.status).toBe("pass");
    } finally {
      if (original === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = original;
    }
  });
});
