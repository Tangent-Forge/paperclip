import { describe, expect, it } from "vitest";
import { canonicalLivenessSourceIdentity, isRecoveryOriginKind } from "../services/recovery/liveness-observer.js";
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";

describe("liveness observer canonical identity", () => {
  it("uses the immutable plugin namespace and origin id", () => {
    expect(canonicalLivenessSourceIdentity({ companyId: "c", id: "issue-a", originKind: "linear", originId: "LIN-7" })).toMatchObject({ provider: "linear", originId: "LIN-7" });
    expect(canonicalLivenessSourceIdentity({ companyId: "c", id: "issue-b", originKind: "linear", originId: "LIN-8" })).not.toEqual(canonicalLivenessSourceIdentity({ companyId: "c", id: "issue-a", originKind: "linear", originId: "LIN-7" }));
  });

  it("uses native issue identity when origin metadata is absent", () => {
    expect(canonicalLivenessSourceIdentity({ companyId: "c", id: "issue-a", originKind: null, originId: null })).toMatchObject({ provider: "paperclip:issue", originId: "issue-a" });
  });

  it("recognizes every recovery origin and preserves null as eligible", () => {
    for (const origin of Object.values(RECOVERY_ORIGIN_KINDS)) expect(isRecoveryOriginKind(origin)).toBe(true);
    expect(isRecoveryOriginKind(null)).toBe(false);
    expect(isRecoveryOriginKind("manual")).toBe(false);
  });
});
