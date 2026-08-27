import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("issue assignment wakeup", () => {
  it("passes the stable handoff idempotency key to the target agent wakeup", async () => {
    const wakeup = vi.fn(async () => ({ id: "run-1" }));

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-2", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      idempotencyKey: "issue-assignment:issue-1:create",
      contextSource: "issue.child_create",
      requestedByActorType: "agent",
      requestedByActorId: "agent-1",
      rethrowOnError: true,
    });

    expect(wakeup).toHaveBeenCalledWith("agent-2", expect.objectContaining({
      source: "assignment",
      idempotencyKey: "issue-assignment:issue-1:create",
      payload: { issueId: "issue-1", mutation: "create" },
      contextSnapshot: { issueId: "issue-1", source: "issue.child_create" },
    }));
  });

  it("does not wake a human-assigned or backlog issue", async () => {
    const wakeup = vi.fn(async () => ({ id: "run-1" }));

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: null, status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.child_create",
    });
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-2", assigneeAgentId: "agent-2", status: "backlog" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.child_create",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });
});
