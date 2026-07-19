import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerAdapter } from "../src/server/index.js";

const fixturePath = fileURLToPath(new URL("fixtures/mcp-stdio-fixture.mjs", import.meta.url));
const adapter = createServerAdapter();

type ExecResult = Awaited<ReturnType<typeof adapter.execute>>;

function makeExecContext(config: Record<string, unknown>) {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const metas: unknown[] = [];
  const spawns: Array<{ pid: number; processGroupId: number | null; startedAt: string }> = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-123",
    agent: { id: "agent-1", companyId: "company-1", name: "Ada", adapterType: "mcp_bridge", adapterConfig: {} },
    runtime: { sessionId: "session-1", sessionParams: { x: 1 }, sessionDisplayId: "disp-1", taskKey: "task-1" },
    config,
    context: { issueId: "issue-7", prompt: "do the thing" },
    onLog: vi.fn(async (stream, chunk) => { logs.push({ stream, chunk }); }),
    onMeta: vi.fn(async (meta) => { metas.push(meta); }),
    onSpawn: vi.fn(async (meta) => { spawns.push(meta); }),
  };
  return { ctx, logs, metas, spawns };
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
    expect(result.summary).toContain("mode");
    expect(spawns).toHaveLength(1);
    expect(metas).toHaveLength(1);
    const metaJson = JSON.stringify(metas[0]);
    expect(metaJson).not.toContain("sessionParams");
    expect(metaJson).not.toContain("authToken");
    expect(metaJson).not.toContain("adapterConfig");
    expect(metaJson).toContain(`"command":"${basename(process.execPath)}"`);
    expect(metaJson).toContain(`"commandArgs":["${fixturePath}","echo"]`);
    expect(metaJson).toContain('"PAPERCLIP_TEST_FLAG":"[redacted]"');
    const resultJsonText = JSON.stringify(result.resultJson);
    expect(resultJsonText).not.toContain("adapterConfig");
    expect(resultJsonText).not.toContain("authToken");
    expect(resultJsonText).not.toContain("sessionParams");
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

  it("redacts and bounds oversized MCP results", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "oversized"], toolName: "oversized" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    const resultText = JSON.stringify(result.resultJson);
    expect(resultText.length).toBeLessThan(150000);
    expect(resultText).not.toContain("examplebearertoken123");
    expect(resultText).not.toContain("example-token-value");
    expect(resultText).not.toContain("example-api-value");
    expect(resultText).not.toContain("example-secret-value");
    expect(resultText).toContain("[redacted]");
    expect(resultText).toContain("keep-me");
    expect(result.summary).toContain("normal text");
    expect(result.summary?.length ?? 0).toBeLessThanOrEqual(1000);
  });

  it("allowlists, redacts, and bounds task context before the tool call", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "echo"], toolName: "echo" });
    ctx.agent.adapterConfig = { authorization: "Bearer adapter-token-value" };
    ctx.runtime.sessionParams = { token: "session-token-value" };
    ctx.context = {
      issueId: "issue-7",
      prompt: `keep this prompt Bearer contextbearertoken123 ${"p".repeat(6000)}`,
      paperclipIssue: {
        id: "issue-7",
        title: "Allowed issue",
        apiKey: "nested-api-value",
        nested: { authorization: "Bearer nestedbearertoken123", ok: true },
      },
      paperclipWake: Array.from({ length: 80 }, (_, index) => ({ index, token: `wake-token-${index}` })),
      paperclipSecrets: { manifest: ["credential-name"] },
      unknownField: { password: "unknown-password-value" },
      authToken: "context-auth-value",
    };
    const result = await adapter.execute(ctx);
    const fixture = parseFixture(result);
    const outbound = fixture.received.context.context;
    const outboundText = JSON.stringify(outbound);
    expect(outbound.issueId).toBe("issue-7");
    expect(outbound.paperclipIssue.title).toBe("Allowed issue");
    expect(outbound.paperclipIssue.apiKey).toBe("[redacted]");
    expect(outbound.paperclipIssue.nested.authorization).toBe("[redacted]");
    expect(outbound.paperclipWake).toHaveLength(24);
    expect(outbound.prompt.length).toBeLessThanOrEqual(4096);
    expect(outboundText.length).toBeLessThan(70_000);
    for (const forbidden of ["paperclipSecrets", "unknownField", "authToken", "adapter-token-value", "session-token-value", "contextbearertoken123", "nestedbearertoken123", "nested-api-value", "unknown-password-value"]) {
      expect(outboundText).not.toContain(forbidden);
    }
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

  it("redacts secrets in tool errors while preserving error semantics", async () => {
    const { ctx } = makeExecContext({ mode: "process", command: process.execPath, args: [fixturePath, "tool-error"], toolName: "tool-error", toolArguments: { authorization: "Bearer secret-token-value" } });
    const result = await adapter.execute(ctx);
    const resultText = JSON.stringify(result.resultJson);
    expect(result.errorCode).toBe("mcp_tool_error");
    expect(result.summary).toContain("tool error");
    expect(resultText).not.toContain("secret-token-value");
    expect(resultText).toContain("[redacted]");
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
