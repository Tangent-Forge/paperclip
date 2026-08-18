import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "./index.js";

describe("Codex local defaults", () => {
  it("keeps approval and sandbox bypass disabled by default", () => {
    expect(DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX).toBe(false);
  });
});
