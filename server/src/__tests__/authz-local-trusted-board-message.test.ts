import { describe, expect, it } from "vitest";
import { assertAuthenticated, assertBoard } from "../routes/authz.js";

function makeReq(input: {
  actor: Express.Request["actor"];
  deploymentMode?: "local_trusted" | "authenticated";
}) {
  return {
    method: "GET",
    actor: input.actor,
    app:
      input.deploymentMode === undefined
        ? undefined
        : { locals: { deploymentMode: input.deploymentMode } },
  } as unknown as Express.Request;
}

// PAP-1975 removed local_trusted's implicit board grant with no replacement
// session path for it (deliberately — see
// doc/plans/2026-08-25-local-trusted-board-access-gap.md, direction B). These
// tests pin the resulting error message so it stays actionable instead of a
// bare "Board access required" that gives no hint the mode itself no longer
// supports an implicit human board identity.
describe("board access denial message in local_trusted mode", () => {
  it("points local_trusted's anonymous denial at the authenticated+private migration path", () => {
    const req = makeReq({ actor: { type: "none", source: "none" }, deploymentMode: "local_trusted" });

    expect(() => assertBoard(req)).toThrow(/local_trusted mode/);
    try {
      assertBoard(req);
    } catch (err) {
      expect((err as Error).message).toContain("authenticated");
      expect((err as Error).message).toContain("private");
      expect((err as Error).message).toContain("PAP-1975");
      expect((err as Error).message).toContain("configure --section server");
    }
  });

  it("also enriches assertAuthenticated's denial the same way", () => {
    const req = makeReq({ actor: { type: "none", source: "none" }, deploymentMode: "local_trusted" });

    try {
      assertAuthenticated(req);
      throw new Error("expected assertAuthenticated to throw");
    } catch (err) {
      expect((err as Error).message).toContain("authenticated");
      expect((err as Error).message).toContain("private");
    }
  });

  it("does not rewrite the message in authenticated mode", () => {
    const req = makeReq({ actor: { type: "none", source: "none" }, deploymentMode: "authenticated" });

    expect(() => assertBoard(req)).toThrow("Board access required");
  });

  it("does not rewrite the message when app/locals is unavailable (e.g. unit tests with a bare req)", () => {
    const req = makeReq({ actor: { type: "none", source: "none" } });

    expect(() => assertBoard(req)).toThrow("Board access required");
  });

  it("does not apply the local_trusted framing to a non-'none' actor denied for an unrelated reason", () => {
    // A real agent credential, just not board-scoped — unrelated to the
    // local_trusted session gap, so the generic message is correct here.
    const req = makeReq({
      actor: { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" },
      deploymentMode: "local_trusted",
    });

    expect(() => assertBoard(req)).toThrow("Board access required");
  });
});
