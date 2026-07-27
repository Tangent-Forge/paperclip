import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type RequestCapture = {
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

function buildContext(overrides: Record<string, unknown> = {}) {
  const configOverrides =
    typeof overrides.config === "object" && overrides.config !== null && !Array.isArray(overrides.config)
      ? (overrides.config as Record<string, unknown>)
      : {};
  const contextOverrides =
    typeof overrides.context === "object" && overrides.context !== null && !Array.isArray(overrides.context)
      ? (overrides.context as Record<string, unknown>)
      : {};

  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent",
      adapterType: "http",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url: "http://127.0.0.1:0/webhook",
      method: "POST",
      timeoutMs: 5000,
      ...configOverrides,
    },
    context: {
      issue: {
        title: "Fix the adapter",
        description: "Make the webhook call",
      },
      tools: ["read", { name: "bash" }],
      ...contextOverrides,
    },
    onLog: async () => {},
  };
}

async function createHttpServer(
  handler: (request: { headers: Record<string, string | string[] | undefined>; body: string }) => Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }> | {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  },
) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const response = await handler({
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    res.statusCode = response.status;
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      res.setHeader(key, value);
    }
    res.end(response.body ?? "");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start HTTP test server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("http adapter execute", () => {
  it("posts the run context with headers and returns structured results", async () => {
    let received: RequestCapture | null = null;
    const server = await createHttpServer(async (request) => {
      received = request;
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          summary: "accepted",
          result: { queued: true },
        }),
      };
    });

    const result = await execute({
      ...buildContext({
        config: {
          url: `${server.baseUrl}/webhook`,
          headers: {
            Authorization: "Bearer secret",
            "X-API-Key": "abc123",
          },
          payloadTemplate: {
            team: "platform",
          },
          tools: ["read", "bash"],
        },
      }),
    });

    await server.close();

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("accepted");
    expect(result.resultJson).toMatchObject({
      statusCode: 200,
      statusText: "OK",
      url: `${server.baseUrl}/webhook`,
      summary: "accepted",
      result: { queued: true },
    });
    if (received === null) throw new Error("Expected HTTP request capture");
    const captured = received as RequestCapture;
    expect(captured.headers.authorization).toBe("Bearer secret");
    expect(captured.headers["x-api-key"]).toBe("abc123");
    expect(String(captured.headers["content-type"] ?? "")).toContain("application/json");
    expect(JSON.parse(captured.body)).toEqual({
      agentId: "agent-1",
      agentName: "Agent",
      companyId: "company-1",
      runId: "run-1",
      issue: "Fix the adapter",
      description: "Make the webhook call",
      tools: ["read", "bash"],
      team: "platform",
    });
  });

  it("surfaces non-2xx responses as adapter errors", async () => {
    const server = await createHttpServer(async () => ({
      status: 503,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        error: "upstream unavailable",
      }),
    }));

    const result = await execute({
      ...buildContext({
        config: {
          url: `${server.baseUrl}/webhook`,
        },
      }),
    });

    await server.close();

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("http_non_2xx");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toContain("503");
    expect(result.resultJson).toMatchObject({
      statusCode: 503,
      statusText: "Service Unavailable",
      url: `${server.baseUrl}/webhook`,
      error: "upstream unavailable",
    });
  });

  it("reports configured request timeout as timed_out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const result = await execute({
      ...buildContext({
        config: {
          url: "https://example.test/webhook",
          timeoutMs: 1,
        },
      }),
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });
});
