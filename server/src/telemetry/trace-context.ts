import type { RequestHandler } from "express";

export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

export interface W3CTraceContextCarrier {
  traceparent?: string;
  tracestate?: string;
}

type OtelApi = {
  context: {
    active(): unknown;
    with<T>(context: unknown, fn: () => T): T;
  };
  propagation: {
    extract(context: unknown, carrier: Record<string, string>): unknown;
    inject(context: unknown, carrier: Record<string, string>): void;
  };
};

let otelApiPromise: Promise<OtelApi | null> | null = null;

async function loadOtelApi(): Promise<OtelApi | null> {
  otelApiPromise ??= importOtelApi();
  return otelApiPromise;
}

async function importOtelApi(): Promise<OtelApi | null> {
  try {
    // @ts-ignore optional peer dep
    return await import("@opentelemetry/api");
  } catch {
    return null;
  }
}

function readHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return readHeaderValue(value[0]);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readW3CTraceContextCarrier(
  headers: Record<string, unknown>,
): W3CTraceContextCarrier {
  const traceparent = readHeaderValue(headers[TRACEPARENT_HEADER] ?? headers.Traceparent);
  const tracestate = readHeaderValue(headers[TRACESTATE_HEADER] ?? headers.Tracestate);
  return {
    ...(traceparent ? { traceparent } : {}),
    ...(tracestate ? { tracestate } : {}),
  };
}

export function mergeW3CTraceContextHeaders(
  headers: Record<string, string>,
  carrier: W3CTraceContextCarrier,
): Record<string, string> {
  if (carrier.traceparent) headers[TRACEPARENT_HEADER] = carrier.traceparent;
  if (carrier.tracestate) headers[TRACESTATE_HEADER] = carrier.tracestate;
  return headers;
}

export function traceContextEnv(carrier: W3CTraceContextCarrier): Record<string, string> {
  return {
    ...(carrier.traceparent ? { OTEL_TRACEPARENT: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { OTEL_TRACESTATE: carrier.tracestate } : {}),
  };
}

export function traceContextFromEnv(env: NodeJS.ProcessEnv = process.env): W3CTraceContextCarrier {
  return {
    ...(readHeaderValue(env.OTEL_TRACEPARENT) ? { traceparent: readHeaderValue(env.OTEL_TRACEPARENT) } : {}),
    ...(readHeaderValue(env.OTEL_TRACESTATE) ? { tracestate: readHeaderValue(env.OTEL_TRACESTATE) } : {}),
  };
}

export async function injectActiveW3CTraceContext(): Promise<W3CTraceContextCarrier> {
  const api = await loadOtelApi();
  if (!api) return {};

  const carrier: Record<string, string> = {};
  api.propagation.inject(api.context.active(), carrier);

  // Paperclip intentionally supports W3C Trace Context only here. Baggage and
  // vendor-specific propagators are neither forwarded nor persisted.
  return readW3CTraceContextCarrier(carrier);
}

export async function runWithExtractedW3CTraceContext<T>(
  carrier: W3CTraceContextCarrier,
  fn: () => T,
): Promise<T> {
  if (!carrier.traceparent) return fn();

  const api = await loadOtelApi();
  if (!api) return fn();

  const context = api.propagation.extract(api.context.active(), {
    ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
  });
  return api.context.with(context, fn);
}

export function traceContextMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const carrier = readW3CTraceContextCarrier(req.headers);
    void runWithExtractedW3CTraceContext(carrier, next).catch(() => next());
  };
}
