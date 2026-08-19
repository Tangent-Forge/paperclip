export const WORK_CONTRACT_VERSION = "tf-work/v1" as const;
export const WORK_CONTRACT_FENCE = "tf-work-contract" as const;
/** Sole Linear workflow state eligible for Paperclip execution admission. */
export const ADMISSION_LINEAR_STATE_NAME = "Ready for Paperclip" as const;

export const DELIVERY_STATES = [
  "defined",
  "assigned",
  "executing",
  "local_artifact_untracked",
  "local_commit_reviewable",
  "published_reviewable",
  "deployed",
  "live_verified",
] as const;

export type DeliveryState = typeof DELIVERY_STATES[number];

export type WorkContract = {
  version: typeof WORK_CONTRACT_VERSION;
  workId: string;
  outcome: string;
  classification: string;
  roles: {
    accountableOwner: string;
    executionQueue: string;
    evaluator: string;
    approvalOwner?: string;
  };
  scope: {
    included: string[];
    excluded: string[];
  };
  executionEnvelope: {
    allowedActions: string[];
    prohibitedActions: string[];
  };
  requirements: string[];
  acceptance: {
    criteria: string[];
    requiredReceipts: string[];
    deliveryState: DeliveryState;
  };
  dependencies: string[];
  stopConditions: string[];
  rollback: string;
};

export type ContractParseResult =
  | { valid: true; contract: WorkContract }
  | { valid: false; errors: string[] };

export type AdmissionResult = {
  admitted: boolean;
  /** `not_triage` retained as a legacy alias of `not_admission_state`. */
  reason: "admitted" | "not_admission_state" | "not_triage" | "missing_contract" | "invalid_contract";
  contract: WorkContract | null;
  errors: string[];
};

export type CompletionEvidence = {
  deliveryState: DeliveryState;
  receipts: Array<{ kind: string; ref: string }>;
};

export type CompletionEvaluation = {
  complete: boolean;
  actualDeliveryState: DeliveryState;
  requiredDeliveryState: DeliveryState;
  missingReceipts: string[];
  reasons: string[];
};

export type ReconciledWorkState = {
  workId: string;
  admitted: boolean;
  admissionReceipt: string | null;
  linearState: string;
  paperclipState: string | null;
  claimedDeliveryState: DeliveryState | null;
  actualDeliveryState: DeliveryState;
  truthfulState: "not_admitted" | "queued" | "executing" | "blocked" | "in_review" | "delivered" | "state_conflict";
  conflicts: string[];
  nextAction: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return stringArray(value) && value.length > 0;
}

function isDeliveryState(value: unknown): value is DeliveryState {
  return typeof value === "string" && (DELIVERY_STATES as readonly string[]).includes(value);
}

export function isAdmissionLinearStateName(name: string | null | undefined): boolean {
  return name?.trim().toLowerCase() === ADMISSION_LINEAR_STATE_NAME.toLowerCase();
}

export function stableLinearWorkId(linearIssueId: string): string {
  return `linear:${linearIssueId}`;
}

export function stableLinearAdmissionReceipt(linearIssueId: string): string {
  // Stable historical prefix — do not rename; used as wakeup idempotency key.
  return `linear-triage:${linearIssueId}`;
}

export function parseWorkContract(description: string | null | undefined): ContractParseResult {
  const source = description ?? "";
  const match = source.match(/```tf-work-contract\s*\n([\s\S]*?)\n```/i);
  if (!match) return { valid: false, errors: ["missing tf-work-contract fenced JSON block"] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return { valid: false, errors: ["tf-work-contract block is not valid JSON"] };
  }

  const root = record(parsed);
  const roles = record(root?.roles);
  const scope = record(root?.scope);
  const envelope = record(root?.executionEnvelope);
  const acceptance = record(root?.acceptance);
  const errors: string[] = [];

  if (root?.version !== WORK_CONTRACT_VERSION) errors.push(`version must be ${WORK_CONTRACT_VERSION}`);
  for (const [name, value] of [
    ["workId", root?.workId],
    ["outcome", root?.outcome],
    ["classification", root?.classification],
    ["roles.accountableOwner", roles?.accountableOwner],
    ["roles.executionQueue", roles?.executionQueue],
    ["roles.evaluator", roles?.evaluator],
    ["rollback", root?.rollback],
  ] as const) {
    if (!nonEmptyString(value)) errors.push(`${name} must be a non-empty string`);
  }
  for (const [name, value] of [
    ["scope.included", scope?.included],
    ["executionEnvelope.allowedActions", envelope?.allowedActions],
    ["executionEnvelope.prohibitedActions", envelope?.prohibitedActions],
    ["requirements", root?.requirements],
    ["acceptance.criteria", acceptance?.criteria],
    ["acceptance.requiredReceipts", acceptance?.requiredReceipts],
    ["stopConditions", root?.stopConditions],
  ] as const) {
    if (!nonEmptyStringArray(value)) errors.push(`${name} must contain at least one non-empty string`);
  }
  for (const [name, value] of [
    ["scope.excluded", scope?.excluded],
    ["dependencies", root?.dependencies],
  ] as const) {
    if (!stringArray(value)) errors.push(`${name} must be an array of non-empty strings`);
  }
  if (!isDeliveryState(acceptance?.deliveryState)) {
    errors.push(`acceptance.deliveryState must be one of: ${DELIVERY_STATES.join(", ")}`);
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, contract: parsed as WorkContract };
}

export function evaluateAdmission(input: {
  linearState: string | null | undefined;
  linearIssueId: string;
  description: string | null | undefined;
}): AdmissionResult {
  if (!isAdmissionLinearStateName(input.linearState)) {
    return {
      admitted: false,
      reason: "not_admission_state",
      contract: null,
      errors: [`only Linear "${ADMISSION_LINEAR_STATE_NAME}" is an execution admission state`],
    };
  }
  const parsed = parseWorkContract(input.description);
  if (!parsed.valid) {
    return {
      admitted: false,
      reason: parsed.errors[0]?.startsWith("missing ") ? "missing_contract" : "invalid_contract",
      contract: null,
      errors: parsed.errors,
    };
  }
  const expectedWorkId = stableLinearWorkId(input.linearIssueId);
  if (parsed.contract.workId !== expectedWorkId) {
    return {
      admitted: false,
      reason: "invalid_contract",
      contract: null,
      errors: [`workId must be ${expectedWorkId}`],
    };
  }
  return { admitted: true, reason: "admitted", contract: parsed.contract, errors: [] };
}

export function evaluateCompletion(contract: WorkContract, evidence: CompletionEvidence): CompletionEvaluation {
  const actualRank = DELIVERY_STATES.indexOf(evidence.deliveryState);
  const requiredRank = DELIVERY_STATES.indexOf(contract.acceptance.deliveryState);
  const receiptKinds = new Set(evidence.receipts.filter((receipt) => nonEmptyString(receipt.ref)).map((receipt) => receipt.kind));
  const missingReceipts = contract.acceptance.requiredReceipts.filter((kind) => !receiptKinds.has(kind));
  const reasons: string[] = [];
  if (actualRank < requiredRank) reasons.push(`delivery is ${evidence.deliveryState}; contract requires ${contract.acceptance.deliveryState}`);
  if (missingReceipts.length > 0) reasons.push(`missing required receipts: ${missingReceipts.join(", ")}`);
  return {
    complete: reasons.length === 0,
    actualDeliveryState: evidence.deliveryState,
    requiredDeliveryState: contract.acceptance.deliveryState,
    missingReceipts,
    reasons,
  };
}

export function reconcileWorkState(input: {
  workId: string;
  linearState: string;
  paperclipState?: string | null;
  admissionReceipt?: string | null;
  claimedDeliveryState?: DeliveryState | null;
  contract?: WorkContract | null;
  evidence: CompletionEvidence;
}): ReconciledWorkState {
  const admissionReceipt = nonEmptyString(input.admissionReceipt) ? input.admissionReceipt : null;
  const currentAdmissionContract = isAdmissionLinearStateName(input.linearState)
    && input.contract?.workId === input.workId;
  const admitted = Boolean(admissionReceipt) || currentAdmissionContract;
  const conflicts: string[] = [];
  const paperclipState = input.paperclipState ?? null;
  const claimed = input.claimedDeliveryState ?? null;
  const linearTerminal = input.linearState.trim().toLowerCase() === "done";
  const paperclipTerminal = paperclipState === "done";
  const completion = input.contract ? evaluateCompletion(input.contract, input.evidence) : null;

  if (input.contract && input.contract.workId !== input.workId) {
    conflicts.push(`contract workId ${input.contract.workId} does not match ${input.workId}`);
  }
  if (!admitted && paperclipState) conflicts.push(`Paperclip work exists without explicit Linear "${ADMISSION_LINEAR_STATE_NAME}" admission`);
  if (["backlog", "todo", "triage"].includes(input.linearState.trim().toLowerCase()) && paperclipState) {
    conflicts.push(`Linear ${input.linearState} is not an admission state but Paperclip work exists`);
  }
  if ((linearTerminal || paperclipTerminal) && completion && !completion.complete) {
    conflicts.push(`terminal tracker state exceeds evidence: ${completion.reasons.join("; ")}`);
  }
  if ((linearTerminal || paperclipTerminal) && !input.contract) {
    conflicts.push("terminal tracker state has no work contract to evaluate");
  }
  if (claimed && DELIVERY_STATES.indexOf(claimed) > DELIVERY_STATES.indexOf(input.evidence.deliveryState)) {
    conflicts.push(`claimed delivery ${claimed} exceeds evidenced delivery ${input.evidence.deliveryState}`);
  }

  let truthfulState: ReconciledWorkState["truthfulState"];
  if (conflicts.length > 0) truthfulState = "state_conflict";
  else if (!admitted) truthfulState = "not_admitted";
  else if (completion?.complete) truthfulState = "delivered";
  else if (paperclipState === "blocked") truthfulState = "blocked";
  else if (paperclipState === "in_review") truthfulState = "in_review";
  else if (paperclipState === "in_progress") truthfulState = "executing";
  else truthfulState = "queued";

  const nextAction = truthfulState === "state_conflict"
    ? "Correct tracker states to match evidence, then re-evaluate."
    : truthfulState === "not_admitted"
      ? `Move the Linear item to ${ADMISSION_LINEAR_STATE_NAME} with a valid work contract.`
      : truthfulState === "delivered"
        ? "No execution action remains; preserve the receipts."
        : "Continue through the named execution queue until acceptance evidence is complete.";

  return {
    workId: input.workId,
    admitted,
    admissionReceipt,
    linearState: input.linearState,
    paperclipState,
    claimedDeliveryState: claimed,
    actualDeliveryState: input.evidence.deliveryState,
    truthfulState,
    conflicts,
    nextAction,
  };
}
