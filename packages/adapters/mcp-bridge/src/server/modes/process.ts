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
const MAX_ERROR_CHARS = 400;
const MAX_CONTEXT_DEPTH = 4;
const MAX_CONTEXT_KEYS = 24;
const MAX_CONTEXT_ARRAY_ENTRIES = 24;
const MAX_CONTEXT_STRING_CHARS = 4096;
const MAX_CONTEXT_TOTAL_CHARS = 64 * 1024;
const MAX_RESULT_DEPTH = 4;
const MAX_RESULT_KEYS = 32;
const MAX_RESULT_ARRAY_ENTRIES = 32;
const MAX_RESULT_STRING_CHARS = 8192;
const MAX_RESULT_TOTAL_CHARS = 128 * 1024;
const REDACTED = "[redacted]";
const CONTEXT_ALLOWED_KEYS = new Set([
  "issueId",
  "taskId",
  "prompt",
  "title",
  "description",
  "instructions",
  "comment",
  "wakeReason",
  "paperclipTaskMarkdown",
  "paperclipIssue",
  "paperclipWake",
  "paperclipWakeComment",
  "paperclipContinuationSummary",
]);
const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|api[-_]?key|private[-_]?key|authorization|cookie|credential)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g;
const LABELED_SECRET_PATTERN = /\b(?:token|secret|password|passwd|api[-_]?key|private[-_]?key|authorization|cookie|credential)\b\s*[:=]\s*[^\s,;]+/gi;

type CleanupStep = () => Promise<void>;

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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactMessage(value: unknown): string {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? "");
  return sanitizeText(text, MAX_ERROR_CHARS);
}

function truncateMessage(message: string, limit = MAX_ERROR_CHARS): string {
  const trimmed = message.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function isValidEnvName(name: string): boolean {
  return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

function isJsonSafe(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value);
  if (kind === "bigint" || kind === "function" || kind === "symbol" || kind === "undefined") return false;
  if (!isPlainObject(value) && !Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonSafe(item, seen));
  return Object.entries(value).every(([key, entry]) => typeof key === "string" && isJsonSafe(entry, seen));
}

function sanitizeText(text: string, limit: number): string {
  const redacted = text.replace(BEARER_PATTERN, REDACTED).replace(LABELED_SECRET_PATTERN, (match) => match.replace(/[:=].*$/, `: ${REDACTED}`));
  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
}

function sanitizeJsonValue(
  value: unknown,
  options: {
    maxDepth: number;
    maxKeys: number;
    maxArrayEntries: number;
    maxStringChars: number;
    totalCharsLeft: { value: number };
  },
  depth = 0,
  seen = new Set<unknown>(),
): unknown {
  if (options.totalCharsLeft.value <= 0) return "…";
  if (value === null) return null;
  if (typeof value === "string") {
    const sanitized = sanitizeText(value, Math.min(options.maxStringChars, options.totalCharsLeft.value));
    options.totalCharsLeft.value -= sanitized.length;
    return sanitized;
  }
  const kind = typeof value;
  if (kind === "number") return Number.isFinite(value) ? value : REDACTED;
  if (kind === "boolean") return value;
  if (kind === "bigint" || kind === "function" || kind === "symbol" || kind === "undefined") return undefined;
  if (!isPlainObject(value) && !Array.isArray(value)) return undefined;
  if (seen.has(value)) return "[cycle]";
  if (depth >= options.maxDepth) return "[depth]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (const entry of value.slice(0, options.maxArrayEntries)) {
        const sanitized = sanitizeJsonValue(entry, options, depth + 1, seen);
        if (sanitized !== undefined) output.push(sanitized);
        if (options.totalCharsLeft.value <= 0) break;
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= options.maxKeys || options.totalCharsLeft.value <= 0) break;
      count += 1;
      const sensitive = SENSITIVE_KEY_PATTERN.test(key);
      if (sensitive) {
        output[key] = REDACTED;
        continue;
      }
      const sanitized = sanitizeJsonValue(entry, options, depth + 1, seen);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function sanitizeContextPayload(ctx: AdapterExecutionContext): Record<string, unknown> {
  const context = isPlainObject(ctx.context) ? ctx.context : {};
  const allowedContext: Record<string, unknown> = {};
  for (const key of Object.keys(context)) {
    if (!CONTEXT_ALLOWED_KEYS.has(key)) continue;
    allowedContext[key] = context[key];
  }
  const sanitized = sanitizeJsonValue({
    runId: ctx.runId,
    agent: { id: ctx.agent.id, companyId: ctx.agent.companyId, name: ctx.agent.name },
    runtime: { taskKey: ctx.runtime.taskKey, sessionDisplayId: ctx.runtime.sessionDisplayId },
    context: allowedContext,
  }, {
    maxDepth: MAX_CONTEXT_DEPTH,
    maxKeys: MAX_CONTEXT_KEYS,
    maxArrayEntries: MAX_CONTEXT_ARRAY_ENTRIES,
    maxStringChars: MAX_CONTEXT_STRING_CHARS,
    totalCharsLeft: { value: MAX_CONTEXT_TOTAL_CHARS },
  });
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizeResultPayload(value: unknown, totalCharsLeft: { value: number }): unknown {
  return sanitizeJsonValue(value, {
    maxDepth: MAX_RESULT_DEPTH,
    maxKeys: MAX_RESULT_KEYS,
    maxArrayEntries: MAX_RESULT_ARRAY_ENTRIES,
    maxStringChars: MAX_RESULT_STRING_CHARS,
    totalCharsLeft,
  });
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
    if (typeof key !== "string" || typeof entry !== "string" || !isValidEnvName(key) || entry.includes("\0")) return null;
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
  for (const key of Object.keys(config)) if (!allowed.has(key)) return { ok: false, reason: `Unknown config field: ${key}` };
  const command = typeof config.command === "string" ? config.command.trim() : "";
  const toolName = typeof config.toolName === "string" ? config.toolName.trim() : "";
  const cwd = config.cwd === undefined ? undefined : typeof config.cwd === "string" && config.cwd.trim() ? config.cwd.trim() : null;
  if (config.contextArgument !== undefined && (typeof config.contextArgument !== "string" || !config.contextArgument.trim())) return { ok: false, reason: "contextArgument must be a non-empty string when provided" };
  const contextArgument = config.contextArgument === undefined ? "context" : config.contextArgument.trim();
  const args = parseStringArray(config.args);
  const env = parseEnv(config.env);
  const timeoutSec = parseTimeoutSec(config.timeoutSec);
  const toolArguments = config.toolArguments === undefined ? {} : isPlainObject(config.toolArguments) && isJsonSafe(config.toolArguments) ? config.toolArguments : null;
  if (!command) return { ok: false, reason: "command must be a non-empty string" };
  if (!toolName) return { ok: false, reason: "toolName must be a non-empty string" };
  if (args === null) return { ok: false, reason: "args must be an array of strings" };
  if (env === null) return { ok: false, reason: "env must be an object of string values" };
  if (timeoutSec === null) return { ok: false, reason: "timeoutSec must be a finite number between 1 and 3600" };
  if (toolArguments === null) return { ok: false, reason: "toolArguments must be a plain JSON object" };
  return { ok: true, value: { command, args, env, cwd: cwd ?? undefined, timeoutSec, toolName, toolArguments, contextArgument } };
}

function buildContextPayload(ctx: AdapterExecutionContext): Record<string, unknown> {
  return sanitizeContextPayload(ctx);
}

function createInvocationMeta(config: ProcessConfig, timeoutSec: number): AdapterInvocationMeta {
  return { adapterType: "mcp_bridge", command: basename(config.command), cwd: config.cwd, commandArgs: config.args, env: config.env ? Object.fromEntries(Object.keys(config.env).map((key) => [key, "[redacted]"])) : undefined, context: { toolName: config.toolName, contextArgument: config.contextArgument, timeoutSec } };
}

function classifyError(error: unknown): { errorCode: string; timedOut: boolean; message: string } {
  const message = truncateMessage(redactMessage(error));
  const lower = message.toLowerCase();
  const errorLike = error instanceof Error ? error : null;
  const timeoutLike = lower.includes("timeout") || lower.includes("timed out") || Boolean(errorLike && ((errorLike as { code?: string }).code === "RequestTimeout" || errorLike.name === "AbortError" || errorLike.name === "TimeoutError"));
  const spawnLike = Boolean(errorLike && ((errorLike as { code?: string }).code === "ENOENT" || (errorLike as { code?: string }).code === "EACCES" || (errorLike as { syscall?: string }).syscall === "spawn"));
  return { errorCode: timeoutLike ? "mcp_bridge_timeout" : spawnLike ? "mcp_bridge_spawn_error" : "mcp_bridge_protocol_error", timedOut: timeoutLike, message };
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

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP bridge timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ProcessStdioClientTransport extends StdioClientTransport {
  constructor(private readonly onSpawn: ((pid: number) => Promise<void> | void) | undefined, options: ConstructorParameters<typeof StdioClientTransport>[0]) {
    super(options);
  }

  override async start(): Promise<void> {
    await super.start();
    const pid = this.pid;
    if (typeof pid === "number") await this.onSpawn?.(pid);
  }
}

export async function executeProcessMode(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const validated = validateProcessConfig(ctx.config);
  if (!validated.ok) {
    const reason = validated.reason;
    return { ...createInvalidModeFailure("process"), errorCode: "mcp_bridge_invalid_config", errorMessage: reason, errorMeta: { reason }, summary: reason, resultJson: { ok: false, errorCode: "mcp_bridge_invalid_config", reason } };
  }

  const config = validated.value;
  const timeoutMs = config.timeoutSec * 1000;
  const invocationMeta = createInvocationMeta(config, config.timeoutSec);
  const logPromises: Promise<void>[] = [];
  let started = false;
  let transportClosed = false;
  let client: Client | null = null;
  const transport = new ProcessStdioClientTransport(async (pid) => {
    await ctx.onSpawn?.({ pid, processGroupId: null, startedAt: new Date().toISOString() });
  }, {
    command: config.command,
    args: config.args,
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    cwd: config.cwd,
    stderr: "pipe",
  });
  const stderr = (transport as { stderr?: { on?: (event: string, listener: (chunk: Buffer | string) => void) => void } }).stderr;
  stderr?.on?.("data", (chunk) => logPromises.push(ctx.onLog("stderr", Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))));
  const closeTransport = async () => {
    if (transportClosed) return;
    transportClosed = true;
    await transport.close().catch(() => undefined);
  };
  const closeClient = async () => {
    if (!client) return;
    const closing = client;
    client = null;
    await closing.close().catch(() => undefined);
  };
  const cleanup: CleanupStep = async () => {
    try {
      if (started) await closeClient();
      else await closeTransport();
    } finally {
      await Promise.allSettled(logPromises);
    }
  };
  const fail = async (error: unknown): Promise<AdapterExecutionResult> => {
    const { errorCode, timedOut, message } = classifyError(error);
    await closeTransport().catch(() => undefined);
    return { exitCode: 1, signal: null, timedOut, errorMessage: message, errorCode: timedOut ? "mcp_bridge_timeout" : started ? "mcp_bridge_protocol_error" : errorCode, resultJson: { ok: false, toolName: config.toolName, error: message }, summary: message };
  };

  try {
    client = new Client({ name: "paperclip-mcp-bridge", version: "0.1.0" });
    const deadline = Date.now() + timeoutMs;
    const connectTimeout = Math.max(0, deadline - Date.now());
    await raceWithTimeout(client.connect(transport), connectTimeout);
    started = true;
    await ctx.onMeta?.(invocationMeta);
    const mergedArgs = { ...config.toolArguments, [config.contextArgument]: buildContextPayload(ctx) };
    const callTimeout = Math.max(0, deadline - Date.now());
    const response = await raceWithTimeout(client.callTool({ name: config.toolName, arguments: mergedArgs }, undefined, { timeout: callTimeout, maxTotalTimeout: callTimeout }), callTimeout);
    const resultBudget = { value: MAX_RESULT_TOTAL_CHARS };
    const content = sanitizeResultPayload(normalizeContent((response as { content?: unknown }).content), resultBudget);
    const structuredContent = sanitizeResultPayload((response as { structuredContent?: unknown }).structuredContent ?? null, resultBudget);
    const isError = Boolean((response as { isError?: unknown }).isError);
    const textContent = (content as Array<Record<string, unknown>>)
      .map((entry) => (entry.type === "text" && typeof entry.text === "string" ? entry.text : null))
      .filter((value): value is string => Boolean(value))
      .join("\n");
    const resultJson = { ok: !isError, toolName: config.toolName, content, structuredContent, isError, contextArgument: config.contextArgument };
    const summary = summarizeText(textContent) ?? `MCP tool ${config.toolName} completed${isError ? " with error" : ""}.`;
    if (isError) return { exitCode: 1, signal: null, timedOut: false, errorMessage: summary, errorCode: "mcp_tool_error", resultJson, summary };
    return { exitCode: 0, signal: null, timedOut: false, resultJson, summary };
  } catch (error) {
    return await fail(error);
  } finally {
    await cleanup();
  }
}

export async function testProcessModeEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const validated = validateProcessConfig(ctx.config);
  if (!validated.ok) return { adapterType: "mcp_bridge", status: "fail", testedAt: new Date().toISOString(), checks: [{ code: "mcp_bridge_process_mode", level: "error", message: validated.reason }] };
  return { adapterType: "mcp_bridge", status: "warn", testedAt: new Date().toISOString(), checks: [{ code: "mcp_bridge_process_mode", level: "warn", message: "Process mode config is valid. Live MCP target is not probed until execution." }] };
}
