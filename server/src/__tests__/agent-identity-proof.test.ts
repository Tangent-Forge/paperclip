import { describe, expect, it } from "vitest";
import {
  buildAgentIdentityProofAcceptanceComment,
  buildAgentIdentityProofContext,
  validateAgentIdentityProof,
} from "../services/agent-identity-proof.js";

const context = buildAgentIdentityProofContext({
  issueId: "issue-1",
  issueIdentifier: "PAP-2367",
  expectedAgentId: "agent-1",
  expectedAgentName: "TF Hermes Lead",
  priorIncompleteCommentIds: ["comment-1", "comment-2"],
});

function receipt() {
  return {
    version: 1,
    execution_mode: "fresh_non_resumed",
    child_paperclip_run_id: "run-1",
    selected_issue_id: "issue-1",
    selected_issue_identifier: "PAP-2367",
    expected_issue_id: "issue-1",
    expected_agent_id: "agent-1",
    identity_api_status: 200,
    identity_name: "TF Hermes Lead",
    identity_id: "agent-1",
    heartbeat_api_status: 200,
    heartbeat_run_id: "run-1",
    heartbeat_agent_id: "agent-1",
    heartbeat_run_matches_child: true,
    signing_secret_present: false,
  };
}

describe("agent identity proof validation", () => {
  it("accepts only a complete receipt bound to the assigned run and agent", () => {
    const validation = validateAgentIdentityProof({
      context,
      runId: "run-1",
      agentId: "agent-1",
      resultJson: { identityProof: receipt() },
    });

    expect(validation).toMatchObject({ passed: true, failures: [] });
    expect(buildAgentIdentityProofAcceptanceComment({ context, runId: "run-1", receipt: validation.receipt! }))
      .toContain("[paperclip-agent-identity-proof:run-1]");
  });

  it("rejects an otherwise plausible receipt that does not prove secret absence", () => {
    const validation = validateAgentIdentityProof({
      context,
      runId: "run-1",
      agentId: "agent-1",
      resultJson: { identityProof: { ...receipt(), signing_secret_present: true } },
    });

    expect(validation).toMatchObject({ passed: false, failures: ["signing_secret_present"] });
  });

  it("rejects a missing structured receipt", () => {
    expect(validateAgentIdentityProof({
      context,
      runId: "run-1",
      agentId: "agent-1",
      resultJson: {},
    })).toMatchObject({ passed: false, failures: ["missing_structured_receipt"] });
  });
});
