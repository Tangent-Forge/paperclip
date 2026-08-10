import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { JanitorModuleId, JanitorModuleResult } from "./modules.js";

const runJanitorModuleMock = vi.hoisted(() => vi.fn());

vi.mock("./modules.js", () => ({
  JANITOR_MODULES: [
    { id: "workspace", label: "Workspace Audit", description: "Workspace", scriptName: "workspace_audit.sh" },
    { id: "storage", label: "Storage Cleanup Scan", description: "Storage", scriptName: "storage_scan.sh" },
    { id: "security", label: "Security Scanner", description: "Security", scriptName: "security_scan.sh" },
  ],
  runJanitorModule: runJanitorModuleMock,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];
const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.PAPERCLIP_API_URL;
const originalRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-janitor-local-"));
  tempRoots.push(root);
  return root;
}

function moduleResult(module: JanitorModuleId, stdout = "", exitCode = 0): JanitorModuleResult {
  return {
    module,
    exitCode,
    stdout,
    stderr: "",
    durationMs: 12,
  };
}

function makeCtx(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      name: "Janitor",
      adapterType: "janitor_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      cwd: root,
      reportDir: path.join(root, ".janitor", "reports"),
      modules: ["storage"],
      dryRun: true,
      approvalRequired: true,
    },
    context: {
      issueId: "33333333-3333-4333-8333-333333333333",
    },
    authToken: "run-jwt",
    onLog: async () => {},
    ...overrides,
  };
}

function installFetch(handler: (url: URL, init: RequestInit) => unknown) {
  const calls: Array<{ url: URL; init: RequestInit; body: unknown }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const requestInit = init ?? {};
    const body = typeof requestInit.body === "string" ? JSON.parse(requestInit.body) : null;
    calls.push({ url, init: requestInit, body });
    const result = handler(url, requestInit);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("janitor_local execute approval gate", () => {
  beforeEach(() => {
    runJanitorModuleMock.mockReset();
    process.env.PAPERCLIP_API_URL = "http://paperclip.test";
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    if (originalRuntimeApiUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
    else process.env.PAPERCLIP_RUNTIME_API_URL = originalRuntimeApiUrl;
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("keeps dry-run scans read-only and does not request approval", async () => {
    const root = await makeTempRoot();
    runJanitorModuleMock.mockResolvedValueOnce(moduleResult("storage", "no actions\n"));

    const result = await execute(makeCtx(root));

    expect(result.exitCode).toBe(0);
    expect(runJanitorModuleMock).toHaveBeenCalledWith("storage", root, expect.objectContaining({
      JANITOR_DRY_RUN: "1",
      JANITOR_APPROVAL_REQUIRED: "1",
    }), 300_000);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("creates a linked approval and waits when active cleanup has structured action records", async () => {
    const root = await makeTempRoot();
    runJanitorModuleMock.mockResolvedValueOnce(moduleResult(
      "storage",
      '{"type":"janitor.action","action":"delete","target":"tmp/cache","description":"Remove old cache","risk":"deletes files"}\n',
    ));
    const calls = installFetch((url) => {
      if (url.pathname === "/api/issues/33333333-3333-4333-8333-333333333333/approvals") return [];
      if (url.pathname === "/api/companies/22222222-2222-4222-8222-222222222222/approvals") {
        return {
          id: "44444444-4444-4444-8444-444444444444",
          type: "request_board_approval",
          status: "pending",
          payload: {},
        };
      }
      if (url.pathname === "/api/issues/33333333-3333-4333-8333-333333333333") return { ok: true };
      throw new Error(`unexpected ${url.pathname}`);
    });

    const result = await execute(makeCtx(root, { config: { cwd: root, reportDir: path.join(root, ".janitor", "reports"), modules: ["storage"], dryRun: false, approvalRequired: true } }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("waiting for board approval");
    expect(runJanitorModuleMock).toHaveBeenCalledTimes(1);
    expect(runJanitorModuleMock.mock.calls[0]?.[2]).toMatchObject({ JANITOR_DRY_RUN: "1" });
    const approvalCreate = calls.find((call) => call.url.pathname.includes("/companies/"));
    expect(approvalCreate?.body).toMatchObject({
      type: "request_board_approval",
      requestedByAgentId: "11111111-1111-4111-8111-111111111111",
      issueIds: ["33333333-3333-4333-8333-333333333333"],
      payload: {
        janitorLocalApproval: {
          modules: ["storage"],
          actionCount: 1,
        },
      },
    });
    const issuePatch = calls.find((call) => call.url.pathname === "/api/issues/33333333-3333-4333-8333-333333333333");
    expect(issuePatch?.body).toMatchObject({ status: "in_review" });
  });

  it("fails closed when active cleanup cannot be linked to an issue", async () => {
    const root = await makeTempRoot();

    const result = await execute(makeCtx(root, {
      config: { cwd: root, modules: ["storage"], dryRun: false, approvalRequired: true },
      context: {},
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("janitor_approval_issue_required");
    expect(result.errorMessage).toContain("Set adapterConfig.dryRun=true");
    expect(result.errorMessage).toContain("payload.issueId");
    expect(result.summary).toContain("dry-run mode");
    expect(runJanitorModuleMock).not.toHaveBeenCalled();
  });

  it("reruns only approved modules in active mode after approval", async () => {
    const root = await makeTempRoot();
    const reportDir = path.join(root, ".janitor", "reports");
    runJanitorModuleMock.mockResolvedValueOnce(moduleResult("storage", "deleted tmp/cache\n"));
    installFetch((url) => {
      if (url.pathname === "/api/approvals/44444444-4444-4444-8444-444444444444") {
        return {
          id: "44444444-4444-4444-8444-444444444444",
          type: "request_board_approval",
          status: "approved",
          payload: {
            janitorLocalApproval: {
              version: 1,
              adapterType: "janitor_local",
              agentId: "11111111-1111-4111-8111-111111111111",
              runId: "run-original",
              cwd: root,
              reportPath: path.join(reportDir, "audit-original.md"),
              modules: ["storage"],
              actionCount: 1,
              actions: [{ module: "storage", action: "delete", target: "tmp/cache", description: "Remove old cache" }],
            },
          },
        };
      }
      if (url.pathname === "/api/issues/33333333-3333-4333-8333-333333333333") return { ok: true };
      throw new Error(`unexpected ${url.pathname}`);
    });

    const result = await execute(makeCtx(root, {
      config: { cwd: root, reportDir, modules: ["storage", "security"], dryRun: false, approvalRequired: true },
      context: {
        issueId: "33333333-3333-4333-8333-333333333333",
        approvalId: "44444444-4444-4444-8444-444444444444",
        approvalStatus: "approved",
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(runJanitorModuleMock).toHaveBeenCalledTimes(1);
    expect(runJanitorModuleMock).toHaveBeenCalledWith("storage", root, expect.objectContaining({ JANITOR_DRY_RUN: "0" }), 300_000);
  });

  it("writes a skipped report and does not run modules after rejection", async () => {
    const root = await makeTempRoot();
    installFetch((url) => {
      if (url.pathname === "/api/approvals/44444444-4444-4444-8444-444444444444") {
        return {
          id: "44444444-4444-4444-8444-444444444444",
          type: "request_board_approval",
          status: "rejected",
          payload: {
            janitorLocalApproval: {
              version: 1,
              adapterType: "janitor_local",
              agentId: "11111111-1111-4111-8111-111111111111",
              runId: "run-original",
              cwd: root,
              reportPath: "dry-run.md",
              modules: ["storage"],
              actionCount: 1,
              actions: [{ module: "storage", action: "delete", target: "tmp/cache", description: "Remove old cache" }],
            },
          },
        };
      }
      if (url.pathname === "/api/issues/33333333-3333-4333-8333-333333333333") return { ok: true };
      throw new Error(`unexpected ${url.pathname}`);
    });

    const result = await execute(makeCtx(root, {
      config: { cwd: root, reportDir: path.join(root, ".janitor", "reports"), modules: ["storage"], dryRun: false, approvalRequired: true },
      context: {
        issueId: "33333333-3333-4333-8333-333333333333",
        approvalId: "44444444-4444-4444-8444-444444444444",
        approvalStatus: "rejected",
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("approval rejected");
    expect(runJanitorModuleMock).not.toHaveBeenCalled();
    const files = await fs.readdir(path.join(root, ".janitor", "reports"));
    expect(files.some((file) => file.startsWith("approval-skipped-"))).toBe(true);
  });
});
