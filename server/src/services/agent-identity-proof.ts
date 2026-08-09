export const AGENT_IDENTITY_PROOF_CONTEXT_KEY = "paperclipIdentityProof";

export interface AgentIdentityProofContext {
  version: 1;
  issueId: string;
  issueIdentifier: string;
  expectedAgentId: string;
  expectedAgentName: string;
  priorIncompleteCommentIds: string[];
}

export interface AgentIdentityProofValidation {
  passed: boolean;
  failures: string[];
  receipt: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildAgentIdentityProofContext(input: Omit<AgentIdentityProofContext, "version">): AgentIdentityProofContext {
  return { version: 1, ...input };
}

export function readAgentIdentityProofContext(context: unknown): AgentIdentityProofContext | null {
  const record = asRecord(context);
  const proof = asRecord(record?.[AGENT_IDENTITY_PROOF_CONTEXT_KEY]);
  if (!proof || proof.version !== 1) return null;
  const issueId = asString(proof.issueId);
  const issueIdentifier = asString(proof.issueIdentifier);
  const expectedAgentId = asString(proof.expectedAgentId);
  const expectedAgentName = asString(proof.expectedAgentName);
  const priorIncompleteCommentIds = Array.isArray(proof.priorIncompleteCommentIds)
    ? proof.priorIncompleteCommentIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (!issueId || !issueIdentifier || !expectedAgentId || !expectedAgentName) return null;
  return {
    version: 1,
    issueId,
    issueIdentifier,
    expectedAgentId,
    expectedAgentName,
    priorIncompleteCommentIds,
  };
}

export function validateAgentIdentityProof(input: {
  context: AgentIdentityProofContext;
  runId: string;
  agentId: string;
  resultJson: unknown;
}): AgentIdentityProofValidation {
  const result = asRecord(input.resultJson);
  const receipt = asRecord(result?.identityProof);
  if (!receipt) {
    return { passed: false, failures: ["missing_structured_receipt"], receipt: null };
  }

  const failures: string[] = [];
  const equal = (field: string, expected: unknown) => {
    if (receipt[field] !== expected) failures.push(field);
  };
  equal("version", 1);
  equal("execution_mode", "fresh_non_resumed");
  equal("child_paperclip_run_id", input.runId);
  equal("selected_issue_id", input.context.issueId);
  equal("selected_issue_identifier", input.context.issueIdentifier);
  equal("expected_issue_id", input.context.issueId);
  equal("expected_agent_id", input.context.expectedAgentId);
  equal("identity_api_status", 200);
  equal("identity_name", input.context.expectedAgentName);
  equal("identity_id", input.context.expectedAgentId);
  equal("heartbeat_api_status", 200);
  equal("heartbeat_run_id", input.runId);
  equal("heartbeat_agent_id", input.agentId);
  equal("heartbeat_run_matches_child", true);
  equal("signing_secret_present", false);

  if (input.context.expectedAgentId !== input.agentId) failures.push("context_expected_agent_id");
  return { passed: failures.length === 0, failures, receipt };
}

export function buildAgentIdentityProofAcceptanceComment(input: {
  context: AgentIdentityProofContext;
  runId: string;
  receipt: Record<string, unknown>;
}) {
  const prior = input.context.priorIncompleteCommentIds.map((id) => `\`${id}\``).join(", ") || "none";
  return [
    `[paperclip-agent-identity-proof:${input.runId}]`,
    "Paperclip validated this corrective acceptance receipt; it supersedes incomplete prior evidence.",
    `prior_incomplete_comment_ids: ${prior}`,
    `child_paperclip_run_id: ${String(input.receipt.child_paperclip_run_id)}`,
    `selected_issue: ${String(input.receipt.selected_issue_identifier)}`,
    `identity_api_status: ${String(input.receipt.identity_api_status)}`,
    `identity_name: ${String(input.receipt.identity_name)}`,
    `identity_id: ${String(input.receipt.identity_id)}`,
    `heartbeat_run_id: ${String(input.receipt.heartbeat_run_id)}`,
    `heartbeat_agent_id: ${String(input.receipt.heartbeat_agent_id)}`,
    `heartbeat_run_matches_child: ${String(input.receipt.heartbeat_run_matches_child)}`,
    `signing_secret_present: ${String(input.receipt.signing_secret_present)}`,
  ].join("\n");
}
