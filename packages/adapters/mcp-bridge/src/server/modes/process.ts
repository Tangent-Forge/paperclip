import { basename } from "node:path";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInvalidModeFailure } from "../shared.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;
const MAX_SUMMARY_CHARS = 1000;

interface ProcessConfig {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  timeoutSec: number;
  toolName: string;
  toolArguments: Record<string, unknown>;
  contextArgument: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactMessage(value: unknown): string {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? "");
  return text.replace(/([A-Za-z]:\\|\/)?[^\s]*?(?:token|secret|password|passwd|key)[^\s]*/gi, "[redacted]");
}

function parseStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value;
}

function parseEnv(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== "string" || typeof entry !== "string") return null;
    env[key] = entry;
  }
  return env;
}

function parseTimeoutSec(value: unknown): number | null {
  if (value === undefined) return DEFAULT_TIMEOUT_SEC;
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_TIMEOUT_SEC || value > MAX_TIMEOUT_SEC) return null;
  return value;
}

function validateProcessConfig(config: Record<string, unknown>): { ok: true; value: ProcessConfig } | { ok: false; reason: string } {
  const allowed = new Set(["mode", "command", "args", "env", "cwd", "timeoutSec", "toolName", "toolArguments", "contextArgument"]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) return { ok: false, reason: `Unknown config field: ${key}` };
  }
  const command = typeof config.command === "string" ? config.command.trim() : "";
  const toolName = typeof config.toolName === "string" ? config.toolName.trim() : "";
  const cwd = config.cwd === undefined ? undefined : typeof config.cwd === "string" && config.cwd.trim() ? config.cwd.trim() : null;
  const contextArgument = typeof config.contextArgument === "string" ? config.contextArgument.trim() : "context";
  const args = parseStringArray(config.args);
  const env = parseEnv(config.env);
  const timeoutSec = parseTimeoutSec(config.timeoutSec);
  const toolArguments = config.toolArguments === undefined ? {} : isPlainObject(config.toolArguments) ? config.toolArguments : null;
  if (!command) return { ok: false, reason: "command must be a non-empty string" };
  if (!toolName) return { ok: false, reason: "toolName must be a non-empty string" };
  if (args === null) return { ok: false, reason: "args must be an array of strings" };
  if (env === null) return { ok: false, reason: "env must be an object of string values" };
  if (timeoutSec === null) return { ok: false, reason: "timeoutSec must be a finite number between 1 and 3600" };
  if (toolArguments === null) return { ok: false, reason: "toolArguments must be a plain object" };
  if (!contextArgument) return { ok: false, reason: "contextArgument must be a non-empty string" };
  return { ok: true, value: { command, args, env, cwd: cwd ?? undefined, timeoutSec, toolName, toolArguments, contextArgument } };
}

function buildContextPayload(ctx: AdapterExecutionContext): Record<string, unknown> {
  return {
    runId: ctx.runId,
    agent: { id: ctx.agent.id, companyId: ctx.agent.companyId, name: ctx.agent.name },
    runtime: { taskKey: ctx.runtime.taskKey, sessionDisplayId: ctx.runtime.sessionDisplayId, sessionParams: ctx.runtime.sessionParams },
    context: ctx.context,
  };
}

function createInvocationMeta(config: ProcessConfig, timeoutSec: number): AdapterInvocationMeta {
  return {
    adapterType: "mcp_bridge",
    command: basename(config.command),
    cwd: config.cwd,
    commandArgs: config.args,
    env: config.env ? Object.fromEntries(Object.keys(config.env).map((key) => [key, "[redacted]"])) : undefined,
    context: { toolName: config.toolName, contextArgument: config.contextArgument, timeoutSec },
  };
}

function summarizeText(text: string | undefined | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  return trimmed.length > MAX_SUMMARY_CHARS ? `${trimmed.slice(0, MAX_SUMMARY_CHARS - 1)}…` : trimmed;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(isPlainObject).map((entry) => entry as Record<string, unknown>);
}

export async function executeProcessMode(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const validated = validateProcessConfig(ctx.config);
  if (!validated.ok) {
    return {
      ...createInvalidModeFailure("process"),
      errorCode: "mcp_bridge_invalid_config",
      errorMessage: validated.reason,
      errorMeta: { reason: validated.reason },
      summary: validated.reason,
      resultJson: { ok: false, errorCode: "mcp_bridge_invalid_config", reason: validated.reason },
    };
  }

  const config = validated.value;
  const timeoutMs = config.timeoutSec * 1000;
  const invocationMeta = createInvocationMeta(config, config.timeoutSec);
  const logPromises: Promise<void>[] = [];
  const trackLog = (stream: "stdout" | "stderr", chunk: string) => {
    logPromises.push(ctx.onLog(stream, chunk));
  };
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    cwd: config.cwd,
  });
  let client: Client | null = null;
  try {
    client = new Client({ name: "paperclip-mcp-bridge", version: "0.1.0" });
    const stderr = (transport as { stderr?: { on?: (event: string, listener: (chunk: Buffer | string) => void) => void } }).stderr;
    stderr?.on?.("data", (chunk) => trackLog("stderr", Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)));
    await client.connect(transport);
    const pid = (transport as { process?: { pid?: number } }).process?.pid;
    if (typeof pid === "number") {
      await ctx.onSpawn?.({ pid, processGroupId: null, startedAt: new Date().toISOString() });
    }
    await ctx.onMeta?.(invocationMeta);
    const mergedArgs = { [config.contextArgument]: buildContextPayload(ctx), ...config.toolArguments };
    const response = await client.callTool({ name: config.toolName, arguments: mergedArgs }, undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    const content = normalizeContent((response as { content?: unknown }).content);
    const structuredContent = (response as { structuredContent?: unknown }).structuredContent ?? null;
    const isError = Boolean((response as { isError?: unknown }).isError);
    const textContent = content
      .map((entry) => (entry.type === "text" && typeof entry.text === "string" ? entry.text : null))
      .filter((value): value is string => Boolean(value))
      .join("\n");
    const resultJson = { ok: !isError, toolName: config.toolName, content, structuredContent, isError, contextArgument: config.contextArgument };
    const summary = summarizeText(textContent) ?? `MCP tool ${config.toolName} completed${isError ? " with error" : ""}.`;
    if (isError) {
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: summary, errorCode: "mcp_tool_error", resultJson, summary };
    }
    return { exitCode: 0, signal: null, timedOut: false, resultJson, summary };
  } catch (error) {
    const message = redactMessage(error);
    const timedOut = message.toLowerCase().includes("timeout");
    return {
      exitCode: 1,
      signal: null,
      timedOut,
      errorMessage: message,
      errorCode: timedOut ? "mcp_bridge_timeout" : client ? "mcp_bridge_protocol_error" : "mcp_bridge_spawn_error",
      resultJson: { ok: false, toolName: config.toolName, error: message },
      summary: message,
    };
  } finally {
    try {
      await client?.close();
    } finally {
      await transport.close();
      await Promise.allSettled(logPromises);
    }
  }
}

export async function testProcessModeEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const validated = validateProcessConfig(ctx.config);
  if (!validated.ok) {
    return {
      adapterType: "mcp_bridge",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [{ code: "mcp_bridge_process_mode", level: "error", message: validated.reason }],
    };
  }
  return {
    adapterType: "mcp_bridge",
    status: "warn",
    testedAt: new Date().toISOString(),
    checks: [{ code: "mcp_bridge_process_mode", level: "warn", message: "Process mode config is valid. Live MCP target is not probed until execution." }],
  };
}
