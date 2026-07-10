import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the opt-in OpenTelemetry bootstrap. The @opentelemetry/* packages
 * are optional peer dependencies and are NOT installed in CI, which is itself
 * part of the contract under test: with the endpoint set but packages absent,
 * the module must warn and settle instead of crashing the server.
 *
 * The module reads OTEL_* env vars at import time, so each test resets the
 * module registry and imports a fresh copy.
 */

const ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";
const PROTOCOL_ENV = "OTEL_EXPORTER_OTLP_PROTOCOL";
const TRACEPARENT_ENV = "OTEL_TRACEPARENT";
const TRACESTATE_ENV = "OTEL_TRACESTATE";

const originalEndpoint = process.env[ENDPOINT_ENV];
const originalProtocol = process.env[PROTOCOL_ENV];
const originalTraceparent = process.env[TRACEPARENT_ENV];
const originalTracestate = process.env[TRACESTATE_ENV];

async function importFreshInstrumentation() {
  vi.resetModules();
  return await import("../instrumentation.js");
}

beforeEach(() => {
  delete process.env[ENDPOINT_ENV];
  delete process.env[PROTOCOL_ENV];
  delete process.env[TRACEPARENT_ENV];
  delete process.env[TRACESTATE_ENV];
});

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env[ENDPOINT_ENV];
  else process.env[ENDPOINT_ENV] = originalEndpoint;
  if (originalProtocol === undefined) delete process.env[PROTOCOL_ENV];
  else process.env[PROTOCOL_ENV] = originalProtocol;
  if (originalTraceparent === undefined) delete process.env[TRACEPARENT_ENV];
  else process.env[TRACEPARENT_ENV] = originalTraceparent;
  if (originalTracestate === undefined) delete process.env[TRACESTATE_ENV];
  else process.env[TRACESTATE_ENV] = originalTracestate;
  vi.restoreAllMocks();
});

describe("resolveProtocol", () => {
  it.each([
    [undefined, "grpc", "@opentelemetry/exporter-trace-otlp-grpc"],
    ["", "grpc", "@opentelemetry/exporter-trace-otlp-grpc"],
    ["grpc", "grpc", "@opentelemetry/exporter-trace-otlp-grpc"],
    ["http/protobuf", "http/protobuf", "@opentelemetry/exporter-trace-otlp-proto"],
    ["http/json", "http/json", "@opentelemetry/exporter-trace-otlp-http"],
    ["HTTP/JSON", "http/json", "@opentelemetry/exporter-trace-otlp-http"],
  ])("maps OTEL_EXPORTER_OTLP_PROTOCOL=%s to %s", async (raw, protocol, packageName) => {
    if (raw === undefined) delete process.env[PROTOCOL_ENV];
    else process.env[PROTOCOL_ENV] = raw;

    const { resolveProtocol } = await importFreshInstrumentation();

    expect(resolveProtocol()).toEqual({ protocol, packageName });
  });

  it("warns and falls back to grpc on an unrecognized protocol", async () => {
    process.env[PROTOCOL_ENV] = "carrier-pigeon";
    // Spy before the import so the assertion holds even if a future change
    // makes the warning fire at module load time instead of on the call.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { resolveProtocol } = await importFreshInstrumentation();

    expect(resolveProtocol().protocol).toBe("grpc");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("carrier-pigeon"));
  });
});

describe("instrumentationReady", () => {
  it("resolves immediately when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    const { instrumentationReady } = await importFreshInstrumentation();

    await expect(instrumentationReady).resolves.toBeUndefined();
  });

  it("settles with a diagnostic instead of throwing when the endpoint is set but packages are missing", async () => {
    process.env[ENDPOINT_ENV] = "http://collector:4318";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { instrumentationReady } = await importFreshInstrumentation();

    // Bootstrap must absorb the failed dynamic imports — the server keeps
    // booting without tracing rather than crashing on an opt-in feature.
    await expect(instrumentationReady).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("@opentelemetry/* packages are not installed"),
      expect.anything(),
    );
  });
});

describe("shutdownInstrumentation", () => {
  it("is a no-op when tracing is off and idempotent across calls", async () => {
    const { shutdownInstrumentation } = await importFreshInstrumentation();

    const first = shutdownInstrumentation();
    const second = shutdownInstrumentation();

    // Memoized: concurrent callers share one shutdown promise.
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
  });

  it("resolves after a failed bootstrap instead of hanging", async () => {
    process.env[ENDPOINT_ENV] = "http://collector:4318";
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { shutdownInstrumentation } = await importFreshInstrumentation();

    await expect(shutdownInstrumentation()).resolves.toBeUndefined();
  });
});

describe("W3C trace context helpers", () => {
  it("reads only traceparent and tracestate from carriers", async () => {
    const {
      readW3CTraceContextCarrier,
      mergeW3CTraceContextHeaders,
    } = await import("../telemetry/trace-context.js");

    const carrier = readW3CTraceContextCarrier({
      traceparent: " 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 ",
      tracestate: ["vendor=value"],
      baggage: "user=not-forwarded",
    });

    expect(carrier).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    });
    expect(mergeW3CTraceContextHeaders({}, carrier)).toEqual({
      traceparent: carrier.traceparent,
      tracestate: carrier.tracestate,
    });
  });

  it("maps active trace context to adapter env names without baggage", async () => {
    process.env[TRACEPARENT_ENV] = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    process.env[TRACESTATE_ENV] = "vendor=value";

    const { traceContextEnv, traceContextFromEnv } = await import("../telemetry/trace-context.js");

    expect(traceContextEnv(traceContextFromEnv())).toEqual({
      OTEL_TRACEPARENT: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      OTEL_TRACESTATE: "vendor=value",
    });
  });
});
