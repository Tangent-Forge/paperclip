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

  it("fail-closes unbound assignment checkout (timer is the only unbound source)", () => {
    expect(
      assertRunMayCheckoutIssue({
        invocationSource: "assignment",
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

  it("allows assignment wake with matching issueId", () => {
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
    expect(bound).toMatchObject({
      ok: true,
      issueId: "issue-9",
      payload: { issueId: "issue-9", reasonTag: "x" },
      contextSnapshot: {
        issueId: "issue-9",
        taskId: "issue-9",
        triggeredBy: "user",
      },
    });
  });

  it("accepts payload-only legacy binding", () => {
    const bound = bindIssueIdToWakeContext({
      issueId: null,
      payload: { issueId: "from-payload" },
      contextSnapshot: {},
    });
    expect(bound).toMatchObject({
      ok: true,
      issueId: "from-payload",
      contextSnapshot: { issueId: "from-payload", taskId: "from-payload" },
    });
  });

  it("accepts matching duplicated identifiers", () => {
    const bound = bindIssueIdToWakeContext({
      issueId: "same",
      payload: { issueId: "same", taskId: "same" },
      contextSnapshot: { issueId: "same", taskId: "same" },
    });
    expect(bound).toMatchObject({ ok: true, issueId: "same" });
  });

  it("rejects top-level A vs payload.issueId B", () => {
    const bound = bindIssueIdToWakeContext({
      issueId: "A",
      payload: { issueId: "B" },
      contextSnapshot: {},
    });
    expect(bound).toMatchObject({
      ok: false,
      code: "contradictory_wake_issue_binding",
    });
  });

  it("rejects payload.issueId A vs payload.taskId B", () => {
    const bound = bindIssueIdToWakeContext({
      issueId: null,
      payload: { issueId: "A", taskId: "B" },
      contextSnapshot: {},
    });
    expect(bound).toMatchObject({
      ok: false,
      code: "contradictory_wake_issue_binding",
    });
  });

  it("rejects payload issueId vs snapshot taskId mismatch", () => {
    const bound = bindIssueIdToWakeContext({
      issueId: null,
      payload: { issueId: "A" },
      contextSnapshot: { taskId: "B" },
    });
    expect(bound).toMatchObject({
      ok: false,
      code: "contradictory_wake_issue_binding",
    });
  });
});
