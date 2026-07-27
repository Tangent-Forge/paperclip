import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

function toStringRecord(value: unknown): Record<string, string> {
  const record = parseObject(value);
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, entryValue]) => [key, typeof entryValue === "string" ? entryValue : String(entryValue)] as const)
      .filter(([, entryValue]) => entryValue.trim().length > 0),
  );
}

function readIssueRecord(context: Record<string, unknown>): Record<string, string> {
  const candidates = [
    parseObject(context.issue),
    parseObject(context.paperclipIssue),
    parseObject(parseObject(context.paperclipWake).issue),
  ];

  for (const candidate of candidates) {
    const title = asString(candidate.title, "").trim();
    const description = asString(candidate.description, "").trim();
    const identifier = asString(candidate.identifier, "").trim();
    const id = asString(candidate.id, "").trim();
    if (title || description || identifier || id) {
      return {
        ...(id ? { id } : {}),
        ...(identifier ? { identifier } : {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      };
    }
  }

  return {};
}

function normalizeConfiguredTools(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(value)) return [];
  const tools: string[] = [];

  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) tools.push(trimmed);
      continue;
    }

    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const name =
        asString(record.name, "").trim() ||
        asString(record.id, "").trim() ||
        asString(record.label, "").trim();
      if (name) tools.push(name);
    }
  }

  return tools;
}

function resolveConfiguredTools(config: Record<string, unknown>, context: Record<string, unknown>): string[] {
  const candidates = [
    config.tools,
    config.configuredTools,
    context.tools,
    context.configuredTools,
    context.paperclipTools,
    parseObject(context.paperclipWake).tools,
  ];

  for (const candidate of candidates) {
    const tools = normalizeConfiguredTools(candidate);
    if (tools.length > 0) return tools;
  }

  return [];
}

function summarizeResponseBody(body: unknown, responseText: string): string | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const summary =
      asString(record.summary, "").trim() ||
      asString(record.result, "").trim() ||
      asString(record.message, "").trim() ||
      asString(record.error, "").trim();
    if (summary) return summary;
  } else if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed) return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  }

  const trimmed = responseText.trim();
  if (!trimmed) return null;
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

function readResponseRecord(response: Response, responseText: string): unknown {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const trimmed = responseText.trim();
  if (!trimmed) return null;

  const shouldTryJson = contentType.includes("application/json") || contentType.includes("+json");
  if (shouldTryJson) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return responseText;
    }
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return responseText;
  }
}

function buildResultRecord(
  response: Response,
  responseBody: unknown,
  responseText: string,
  requestUrl: string,
): Record<string, unknown> {
  const bodyRecord =
    responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
      ? (responseBody as Record<string, unknown>)
      : responseBody == null
        ? {}
        : { response: responseBody };

  return {
    statusCode: response.status,
    statusText: response.statusText || null,
    url: requestUrl,
    ...bodyRecord,
    ...(responseBody == null && responseText.trim() ? { responseText } : {}),
  };
}

function buildRequestBody(
  ctx: Pick<AdapterExecutionContext, "agent" | "config" | "context" | "runId">,
): Record<string, unknown> {
  const issue = readIssueRecord(ctx.context);
  const tools = resolveConfiguredTools(ctx.config, ctx.context);
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);

  const basePayload: Record<string, unknown> = {
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    tools,
    ...(issue.title ? { issue: issue.title } : {}),
    ...(issue.description ? { description: issue.description } : {}),
  };

  return {
    ...basePayload,
    ...payloadTemplate,
  };
}

function buildHeaders(value: unknown): Record<string, string> {
  const headers = toStringRecord(value);
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  return {
    ...headers,
    ...(hasContentType ? {} : { "content-type": "application/json" }),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "HTTP adapter missing url",
      errorCode: "http_missing_url",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `HTTP adapter received an invalid URL: ${url}`,
      errorCode: "http_invalid_url",
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `HTTP adapter requires an http(s) URL, received: ${parsedUrl.protocol}`,
      errorCode: "http_invalid_url_protocol",
    };
  }

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const body = buildRequestBody({ agent, config, context, runId });

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(parsedUrl.toString(), {
      method,
      headers: buildHeaders(config.headers),
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    const responseText = await res.text().catch(() => "");
    const responseBody = readResponseRecord(res, responseText);

    if (!res.ok) {
      const responsePreview = summarizeResponseBody(responseBody, responseText);
      const transient = res.status >= 500;
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `HTTP ${method} ${parsedUrl.toString()} failed with status ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${responsePreview ? `: ${responsePreview}` : ""}`,
        errorCode: "http_non_2xx",
        ...(transient ? { errorFamily: "transient_upstream" } : {}),
        resultJson: buildResultRecord(res, responseBody, responseText, parsedUrl.toString()),
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary:
        summarizeResponseBody(responseBody, responseText) ??
        `HTTP ${method} ${parsedUrl.toString()}`,
      resultJson: buildResultRecord(res, responseBody, responseText, parsedUrl.toString()),
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${parsedUrl.toString()} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `HTTP ${method} ${parsedUrl.toString()} failed: ${message}`,
      errorCode: "http_request_failed",
      errorFamily: "transient_upstream",
      resultJson: {
        url: parsedUrl.toString(),
        error: message,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
