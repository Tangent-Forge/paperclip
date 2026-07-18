import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerAdapter } from "../src/server/index.js";

const fixturePath = fileURLToPath(new URL("fixtures/mcp-stdio-fixture.mjs", import.meta.url));
const adapter = createServerAdapter();

type ExecResult = Awaited<ReturnType<typeof adapter.execute>>;

function makeExecContext(config: Record<string, unknown>) {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const metas: unknown[] = [];
  const spawns: Array<{ pid: number; processGroupId: number | null; startedAt: string }> = [];
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

function resultJson(result: ExecResult): Record<string, unknown> {
  return (result.resultJson ?? {}) as Record<string, unknown>;
}

function parseFixture(result: ExecResult) {
  const payload = resultJson(result).content as Array<{ text?: string }>;
  return JSON.parse(payload[0]?.text ?? "{}");
}

async function waitForProcessExit(pid: number, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("mcp bridge process mode", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

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
    mkdirSync(cwd, { recursive: true });
    tempDirs.push(cwd);
    const { ctx, logs, metas, spawns } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "echo"], cwd, timeoutSec: 5, toolName: "echo", toolArguments: { literal: "value" }, contextArgument: "taskContext", env: { PAPERCLIP_TEST_FLAG: "1" } });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.toolName).toBe("echo");
    expect(result.summary).toContain("mode");
    expect(spawns).toHaveLength(1);
    expect(metas).toHaveLength(1);
    expect(JSON.stringify(metas[0])).not.toContain("sessionParams");
    expect(JSON.stringify(metas[0])).not.toContain("authToken");
    expect(JSON.stringify(metas[0])).not.toContain("adapterConfig");
    expect(JSON.stringify(metas[0])).toContain(`"command":"${basename(process.execPath)}"`);
    expect(JSON.stringify(metas[0])).toContain(`"commandArgs":["${fixturePath}","echo"]`);
    expect(JSON.stringify(metas[0])).toContain('"PAPERCLIP_TEST_FLAG":"[redacted]"');
    expect(JSON.stringify(result.resultJson)).not.toContain("adapterConfig");
    expect(JSON.stringify(result.resultJson)).not.toContain("authToken");
    expect(JSON.stringify(result.resultJson)).not.toContain("sessionParams");
    expect(logs.some((entry) => entry.stream === "stderr" && entry.chunk.includes("fixture-stderr-marker"))).toBe(true);
    const fixture = parseFixture(result);
    expect(fixture.received.callCount).toBe(1);
    expect(fixture.received.taskContext.runId).toBe("run-123");
    expect(fixture.received.taskContext.agent.id).toBe("agent-1");
    expect(fixture.received.taskContext.runtime.taskKey).toBe("task-1");
    expect(fixture.received.taskContext.runtime.sessionDisplayId).toBe("disp-1");
    expect(fixture.received.taskContext.context.issueId).toBe("issue-7");
    expect(fixture.received.literal).toBe("value");
    expect(fixture.received.cwd).toBe(cwd);
    expect(fixture.received.env.PAPERCLIP_TEST_FLAG).toBe("1");
  });

  it("supports the default context argument name", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "echo"], toolName: "echo", toolArguments: { literal: "default" } });
    const result = await adapter.execute(ctx);
    const fixture = parseFixture(result);
    expect(fixture.received.context.runId).toBe("run-123");
    expect(fixture.received.callCount).toBe(1);
  });

  it("lets bounded context win over caller-supplied overwrite attempts", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "echo"], toolName: "echo", toolArguments: { taskContext: { injected: true }, literal: "value" }, contextArgument: "taskContext" });
    const result = await adapter.execute(ctx);
    const fixture = parseFixture(result);
    expect(fixture.received.taskContext.runId).toBe("run-123");
    expect(fixture.received.taskContext.injected).toBeUndefined();
  });

  it("treats tool errors as mcp_tool_error and preserves result payload", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "tool-error"], toolName: "tool-error" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("mcp_tool_error");
    expect(result.resultJson?.isError).toBe(true);
    expect((result.resultJson?.structuredContent as { failed?: boolean }).failed).toBe(true);
  });

  it("times out a delayed tool call and terminates the child", async () => {
    const { ctx, spawns } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "delay"], toolName: "delay", timeoutSec: 1 });
    const result = await adapter.execute(ctx);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("mcp_bridge_timeout");
    expect(spawns).toHaveLength(1);
    await waitForProcessExit(spawns[0].pid);
  });

  it("times out a handshake hang and terminates the child", async () => {
    const { ctx, spawns } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "hang-handshake"], toolName: "echo", timeoutSec: 1 });
    const result = await adapter.execute(ctx);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("mcp_bridge_timeout");
    expect(spawns).toHaveLength(1);
    await waitForProcessExit(spawns[0].pid);
  });

  it("treats nonexistent command as spawn error", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: "/definitely/not/a/real-command-xyz", toolName: "echo" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("mcp_bridge_spawn_error");
  });

  it("treats unknown tools as protocol errors", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "echo"], toolName: "does-not-exist" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("mcp_bridge_protocol_error");
  });

  it("rejects non-plain and non-JSON toolArguments before spawn", async () => {
    class Box { value = 1; }
    const cyclic: Record<string, unknown> = { self: null };
    cyclic.self = cyclic;
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, toolName: "echo", toolArguments: new Box(), cwd: join(tmpdir(), `paperclip-${randomUUID()}`) });
    const cyclicResult = await adapter.execute(makeExecContext({ mode: "process", command: process.execPath, toolName: "echo", toolArguments: cyclic }).ctx);
    const result = await adapter.execute(ctx);
    expect(result.errorCode).toBe("mcp_bridge_invalid_config");
    expect(cyclicResult.errorCode).toBe("mcp_bridge_invalid_config");
    expect(ctx.onSpawn).not.toHaveBeenCalled();
  });

  it("rejects invalid env names and values before spawn", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, toolName: "echo", env: { "BAD=NAME": "x", GOOD: "ok" } });
    const result = await adapter.execute(ctx);
    expect(result.errorCode).toBe("mcp_bridge_invalid_config");
    expect(ctx.onSpawn).not.toHaveBeenCalled();
  });

  it("rejects NUL env values and blank context arguments before spawn", async () => {
    const nulEnv = await adapter.execute(makeExecContext({ mode: "process", command: process.execPath, toolName: "echo", env: { GOOD: "bad\0value" } }).ctx);
    const blankContext = await adapter.execute(makeExecContext({ mode: "process", command: process.execPath, toolName: "echo", contextArgument: "   " }).ctx);
    expect(nulEnv.errorCode).toBe("mcp_bridge_invalid_config");
    expect(blankContext.errorCode).toBe("mcp_bridge_invalid_config");
  });

  it("does not shell-expand command arguments", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "echo", "literal;echo", "$(whoami)", "a&&b"], toolName: "echo" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    const fixture = parseFixture(result);
    expect(fixture.received.argv).toContain("literal;echo");
    expect(fixture.received.argv).toContain("$(whoami)");
    expect(fixture.received.argv).toContain("a&&b");
  });

  it("keeps http and plugin scaffolds unchanged", async () => {
    const http = await adapter.execute({ runId: "r", agent: { id: "a", companyId: "c", name: "n", adapterType: "mcp_bridge", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config: { mode: "http" }, context: {}, onLog: async () => {} });
    const plugin = await adapter.testEnvironment({ companyId: "c", adapterType: "mcp_bridge", config: { mode: "plugin" } });
    expect(http.errorCode).toBe("mcp_bridge_not_implemented");
    expect(plugin.status).toBe("warn");
  });
});
