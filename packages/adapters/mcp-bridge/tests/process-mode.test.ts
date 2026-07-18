import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createServerAdapter } from "../src/server/index.js";

const fixturePath = fileURLToPath(pathToFileURL(join(process.cwd(), "tests/fixtures/mcp-stdio-fixture.mjs")));
const adapter = createServerAdapter();

function makeExecContext(config: Record<string, unknown>) {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const metas: unknown[] = [];
  const spawns: unknown[] = [];
  return {
    ctx: {
      runId: "run-123",
      agent: { id: "agent-1", companyId: "company-1", name: "Ada", adapterType: "mcp_bridge", adapterConfig: {} },
      runtime: { sessionId: "session-1", sessionParams: { x: 1 }, sessionDisplayId: "disp-1", taskKey: "task-1" },
      config,
      context: { issueId: "issue-7", prompt: "do the thing" },
      onLog: vi.fn(async (stream, chunk) => { logs.push({ stream, chunk }); }),
      onMeta: vi.fn(async (meta) => { metas.push(meta); }),
      onSpawn: vi.fn(async (meta) => { spawns.push(meta); }),
    },
    logs,
    metas,
    spawns,
  };
}

describe("mcp bridge process mode", () => {
  it("fails closed before spawn for invalid config", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: "", toolName: "echo" });
    const result = await adapter.execute(ctx);
    expect(result.errorCode).toBe("mcp_bridge_invalid_config");
    expect(ctx.onSpawn).not.toHaveBeenCalled();
  });

  it("validates config in environment tests", async () => {
    const fail = await adapter.testEnvironment({ companyId: "c1", adapterType: "mcp_bridge", config: { mode: "process", command: "", toolName: "echo" } });
    expect(fail.status).toBe("fail");
    expect(fail.checks[0]?.code).toBe("mcp_bridge_process_mode");

    const warn = await adapter.testEnvironment({ companyId: "c1", adapterType: "mcp_bridge", config: { mode: "process", command: process.execPath, toolName: "echo" } });
    expect(warn.status).toBe("warn");
  });

  it("runs the real stdio handshake and one tool call with bounded context", async () => {
    const cwd = join(tmpdir(), `paperclip-mcp-${randomUUID()}`);
    const { ctx, logs, metas, spawns } = makeExecContext({
      mode: "process",
      command: process.execPath,
      args: [fixturePath, "echo"],
      cwd,
      timeoutSec: 5,
      toolName: "echo",
      toolArguments: { literal: "value" },
      contextArgument: "taskContext",
      env: { PAPERCLIP_TEST_FLAG: "1" },
    });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.toolName).toBe("echo");
    expect(result.summary).toContain("hello from fixture");
    expect(spawns).toHaveLength(1);
    expect(metas).toHaveLength(1);
    expect(JSON.stringify(metas[0])).not.toContain("PAPERCLIP_TEST_FLAG\":\"1");
    expect(logs.some((entry) => entry.stream === "stderr" && entry.chunk.includes("fixture-stderr-marker"))).toBe(true);
    const structured = result.resultJson?.structuredContent as any;
    expect(structured.received.taskContext.runId).toBe("run-123");
    expect(structured.received.taskContext.agent.id).toBe("agent-1");
    expect(structured.received.taskContext.context.issueId).toBe("issue-7");
    expect(structured.received.literal).toBe("value");
  });

  it("treats tool errors as mcp_tool_error and preserves result payload", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "tool-error"], toolName: "tool-error" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("mcp_tool_error");
    expect(result.resultJson?.isError).toBe(true);
  });

  it("times out a delayed tool call", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "delay"], toolName: "delay", timeoutSec: 1 });
    const result = await adapter.execute(ctx);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("mcp_bridge_timeout");
  });

  it("treats nonexistent command as spawn error", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: "/definitely/not/a/real-command-xyz", toolName: "echo" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("mcp_bridge_spawn_error");
  });

  it("treats invalid tool responses as protocol errors", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "bad-protocol"], toolName: "bad-protocol" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("mcp_bridge_protocol_error");
  });

  it("does not shell-expand command arguments", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "echo", "literal;echo", "$(whoami)", "a&&b"], toolName: "echo" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    const structured = result.resultJson?.structuredContent as any;
    expect(structured.received.argv).toContain("literal;echo");
    expect(structured.received.argv).toContain("$(whoami)");
    expect(structured.received.argv).toContain("a&&b");
  });

  it("keeps http and plugin scaffolds unchanged", async () => {
    const http = await adapter.execute({ runId: "r", agent: { id: "a", companyId: "c", name: "n", adapterType: "mcp_bridge", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config: { mode: "http" }, context: {}, onLog: async () => {} });
    const plugin = await adapter.testEnvironment({ companyId: "c", adapterType: "mcp_bridge", config: { mode: "plugin" } });
    expect(http.errorCode).toBe("mcp_bridge_not_implemented");
    expect(plugin.status).toBe("warn");
  });
});
