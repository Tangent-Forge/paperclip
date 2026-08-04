import { describe, expect, it } from "vitest";
import { canonicalizeIssueIdentity } from "../services/recovery/liveness-observer.js";

describe("liveness v2 observer identity", () => {
  it("uses immutable origin identity for plugin issues and paperclip issue ids for native issues", () => {
    expect(
      canonicalizeIssueIdentity({ id: "issue-1", originKind: "jira:issue", originId: "JRA-99" }),
    ).toEqual({ canonicalSourceProvider: "jira:issue", canonicalSourceOriginId: "JRA-99" });

    expect(canonicalizeIssueIdentity({ id: "issue-2", originKind: null, originId: null })).toEqual({
      canonicalSourceProvider: "paperclip:issue",
      canonicalSourceOriginId: "issue-2",
    });
  });
});
