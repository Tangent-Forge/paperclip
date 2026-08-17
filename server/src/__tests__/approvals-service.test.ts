import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });
});

describe("approvalService requestRevision/resubmit race safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats repeated request-revision retries as no-ops after another worker already requested revision", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("revision_requested")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.requestRevision("approval-1", "board", "please fix X");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("revision_requested");
  });

  it("applies request-revision when the conditional update is newly applied", async () => {
    const revisionRequested = createApproval("revision_requested");
    const dbStub = createDbStub([[createApproval("pending")]], [revisionRequested]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.requestRevision("approval-1", "board", "please fix X");

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("revision_requested");
  });

  it("treats repeated resubmit retries as no-ops after another worker already resubmitted", async () => {
    const dbStub = createDbStub(
      [[createApproval("revision_requested")], [createApproval("pending")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.resubmit("approval-1", { foo: "bar" });

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("pending");
  });

  it("applies resubmit when the conditional update is newly applied", async () => {
    const pending = createApproval("pending");
    const dbStub = createDbStub([[createApproval("revision_requested")]], [pending]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.resubmit("approval-1", { foo: "bar" });

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("pending");
  });
});
