import { describe, expect, it } from "vitest";
import {
  isPaperclipLocalIssueOriginKind,
  issueIdentifierPrefixForOrigin,
} from "./constants.js";

describe("Paperclip-local issue identifiers", () => {
  it.each([
    "routine_execution",
    "stale_active_run_evaluation",
    "harness_liveness_escalation",
    "issue_productivity_review",
    "stranded_issue_recovery",
    "issue_graph_liveness_escalation",
    "agent_health_escalation",
    "dependency_blocked_escalation",
    "plugin:paperclipai.linear-sync:incident",
    "plugin:paperclipai.llm-wiki:operation:ingest",
  ])("classifies %s as local-only", (originKind) => {
    expect(isPaperclipLocalIssueOriginKind(originKind)).toBe(true);
    expect(issueIdentifierPrefixForOrigin("TAN", originKind)).toBe("PCL");
  });

  it.each([
    null,
    undefined,
    "",
    "manual",
    "plugin:paperclipai.linear-sync:linear-issue",
  ])("preserves the company prefix for %s", (originKind) => {
    expect(isPaperclipLocalIssueOriginKind(originKind)).toBe(false);
    expect(issueIdentifierPrefixForOrigin("TAN", originKind)).toBe("TAN");
  });
});
