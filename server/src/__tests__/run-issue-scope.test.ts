import { describe, expect, it } from "vitest";
import { assertRunMayCheckoutIssue, bindIssueIdToWakeContext } from "../services/run-issue-scope.js";

describe("assertRunMayCheckoutIssue", () => {
  it("allows timer wakes to checkout without a bound issueId (inbox pick-work)", () => {
    expect(
      assertRunMayCheckoutIssue({
        invocationSource: "timer",
        runIssueId: null,
        targetIssueId: "issue-1",
      }),
    ).toEqual({ ok: true });
  });

  it("fail-closes unbound on_demand checkout", () => {
    expect(
      assertRunMayCheckoutIssue({
        invocationSource: "on_demand",
        runIssueId: null,
        targetIssueId: "issue-1",
      }),
    ).toMatchObject({
      ok: false,
      code: "unbound_on_demand_checkout_forbidden",
    });
  });

  it("fail-closes unbound automation checkout", () => {
    expect(
      assertRunMayCheckoutIssue({
        invocationSource: "automation",
        runIssueId: null,
        targetIssueId: "issue-1",
      }),
    ).toMatchObject({
      ok: false,
      code: "unbound_on_demand_checkout_forbidden",
    });
  });

  it("allows issue-bound on_demand checkout when ids match", () => {
    expect(
      assertRunMayCheckoutIssue({
        invocationSource: "on_demand",
        runIssueId: "issue-1",
        targetIssueId: "issue-1",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects checkout when run is bound to a different issue", () => {
    expect(
      assertRunMayCheckoutIssue({
        invocationSource: "assignment",
        runIssueId: "issue-a",
        targetIssueId: "issue-b",
      }),
    ).toMatchObject({
      ok: false,
      code: "run_issue_scope_mismatch",
    });
  });

  it("allows assignment wake without issueId (unusual) and with matching issueId", () => {
    expect(
      assertRunMayCheckoutIssue({
        invocationSource: "assignment",
        runIssueId: null,
        targetIssueId: "issue-1",
      }),
    ).toEqual({ ok: true });
    expect(
      assertRunMayCheckoutIssue({
        invocationSource: "assignment",
        runIssueId: "issue-1",
        targetIssueId: "issue-1",
      }),
    ).toEqual({ ok: true });
  });
});

describe("bindIssueIdToWakeContext", () => {
  it("promotes top-level issueId into payload and contextSnapshot", () => {
    const bound = bindIssueIdToWakeContext({
      issueId: "issue-9",
      payload: { reasonTag: "x" },
      contextSnapshot: { triggeredBy: "user" },
    });
    expect(bound.issueId).toBe("issue-9");
    expect(bound.payload).toMatchObject({ issueId: "issue-9", reasonTag: "x" });
    expect(bound.contextSnapshot).toMatchObject({
      issueId: "issue-9",
      taskId: "issue-9",
      triggeredBy: "user",
    });
  });

  it("prefers existing payload issueId over empty top-level", () => {
    const bound = bindIssueIdToWakeContext({
      issueId: null,
      payload: { issueId: "from-payload" },
      contextSnapshot: {},
    });
    expect(bound.issueId).toBe("from-payload");
    expect(bound.contextSnapshot.issueId).toBe("from-payload");
  });
});
