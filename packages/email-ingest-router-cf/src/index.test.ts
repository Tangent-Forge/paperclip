import { afterEach, describe, expect, it, vi } from "vitest";

import worker, {
  buildDeliveryId,
  isAllowedRecipient,
  isAllowedSender,
  pickAgent,
  sortObjectKeys,
  truncateForLog,
} from "./index.js";

function rawEmail(overrides: { from?: string; to?: string; subject?: string; body?: string; messageId?: string } = {}): string {
  const from = overrides.from ?? "Council Lead <lead@example.gov>";
  const to = overrides.to ?? "Ops <ingest+cto@tf-hub.dev>";
  const subject = overrides.subject ?? "Sensitive Budget Review";
  const body = overrides.body ?? "Hermes lead should receive this intake.";
  const messageId = overrides.messageId ?? "<mail-123@example.com>";
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    "Date: Tue, 08 Jun 2026 12:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
}

function forwardableEmail(raw: string, input: { from?: string; to?: string } = {}): ForwardableEmailMessage {
  return {
    raw,
    from: input.from ?? "lead@example.gov",
    to: input.to ?? "ingest+cto@tf-hub.dev",
  } as unknown as ForwardableEmailMessage;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("email ingest router helpers", () => {
  it("routes known ingest tags and falls back for unknown tags", () => {
    expect(pickAgent(["Ops <ingest+cto@tf-hub.dev>"], "hermes")).toBe("cto");
    expect(pickAgent(["ingest+risk-auditor@tf-hub.dev"], "hermes")).toBe("risk");
    expect(pickAgent(["ingest+unknown@tf-hub.dev"], "hermes")).toBe("hermes");
  });

  it("sorts payload keys recursively for signature compatibility", () => {
    expect(sortObjectKeys({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }] })).toEqual({
      a: { b: 3, y: 2 },
      list: [{ c: 5, d: 4 }],
      z: 1,
    });
  });

  it("keeps log values single-line and bounded", () => {
    expect(truncateForLog("  hello\nworld\tagain  ")).toBe("hello world again");
    expect(truncateForLog("abcdef", 4)).toBe("a...");
  });

  it("builds stable non-secret delivery ids", () => {
    const first = buildDeliveryId("<msg@example.com>", "sender@example.com", "2026-06-13T00:00:00Z");
    const second = buildDeliveryId("<msg@example.com>", "other@example.com", "2026-06-14T00:00:00Z");
    const fallback = buildDeliveryId("", "sender@example.com", "2026-06-13T00:00:00Z");

    expect(first).toMatch(/^mail_[0-9a-f]{8}$/);
    expect(second).toBe(first);
    expect(fallback).toMatch(/^mail_[0-9a-f]{8}$/);
    expect(fallback).not.toBe(first);
  });

  it("uses council-style sender and recipient allowlist matching", () => {
    expect(isAllowedSender("Lead <lead@example.gov>", ["example.gov"])).toBe(true);
    expect(isAllowedSender("Lead <lead@dept.example.gov>", ["example.gov"])).toBe(true);
    expect(isAllowedSender("Lead <lead@example.com>", ["example.gov"])).toBe(false);

    expect(isAllowedRecipient(["Ops <ingest+cto@tf-hub.dev>"], ["ingest\\+"])).toBe(true);
    expect(isAllowedRecipient(["Ops <ops@tf-hub.dev>"], ["ingest\\+"])).toBe(false);
  });

  it("posts signed payloads with a stable delivery id idempotency key", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const message = forwardableEmail(rawEmail());
    const env = {
      PAPERCLIP_TRIGGER_SECRET: "secret",
      PAPERCLIP_TRIGGER_URL: "https://paperclip.example.test/fire",
      DEFAULT_AGENT: "hermes",
      ALLOWED_SENDER_DOMAINS: "example.gov",
      ALLOWED_RECIPIENT_PATTERNS: "ingest\\+",
    };

    await worker.email(message, env, {} as ExecutionContext);
    await worker.email(message, env, {} as ExecutionContext);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const headers = firstInit.headers as Record<string, string>;
    const secondHeaders = secondInit.headers as Record<string, string>;
    const body = String(firstInit.body);
    const timestamp = headers["X-Paperclip-Timestamp"];
    const expectedSignature = await hmacHex("secret", `${timestamp}.${body}`);

    expect(firstUrl).toBe("https://paperclip.example.test/fire");
    expect(headers["Idempotency-Key"]).toMatch(/^mail_[0-9a-f]{8}$/);
    expect(secondHeaders["Idempotency-Key"]).toBe(headers["Idempotency-Key"]);
    expect(headers["X-Paperclip-Signature"]).toBe(`sha256=${expectedSignature}`);
    const parsedBody = JSON.parse(body);
    expect(parsedBody).toMatchObject({
      agent: "cto",
      gmail_message_id: "<mail-123@example.com>",
      subject: "Sensitive Budget Review",
    });
    expect(parsedBody.body_text).toContain("Hermes lead should receive this intake.");

    const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("email_ingest_received");
    expect(logs).toContain("email_ingest_delivered");
    expect(logs).not.toContain("Sensitive Budget Review");
    expect(logs).not.toContain("lead@example.gov");
    expect(logs).not.toContain("Hermes lead should receive this intake.");
  });

  it("skips disallowed email before posting to the public trigger", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await worker.email(
      forwardableEmail(rawEmail({ from: "Person <person@example.com>" }), { from: "person@example.com" }),
      {
        PAPERCLIP_TRIGGER_SECRET: "secret",
        PAPERCLIP_TRIGGER_URL: "https://paperclip.example.test/fire",
        DEFAULT_AGENT: "hermes",
        ALLOWED_SENDER_DOMAINS: "example.gov",
        ALLOWED_RECIPIENT_PATTERNS: "ingest\\+",
      },
      {} as ExecutionContext,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('"status":"filtered"');
    expect(String(logSpy.mock.calls[0]?.[0])).not.toContain("person@example.com");
  });

  it("redacts Paperclip failure response details from logs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Sensitive Budget Review lead@example.gov", { status: 500 })));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(worker.email(
      forwardableEmail(rawEmail()),
      {
        PAPERCLIP_TRIGGER_SECRET: "secret",
        PAPERCLIP_TRIGGER_URL: "https://paperclip.example.test/fire",
        DEFAULT_AGENT: "hermes",
        ALLOWED_SENDER_DOMAINS: "example.gov",
        ALLOWED_RECIPIENT_PATTERNS: "ingest\\+",
      },
      {} as ExecutionContext,
    )).rejects.toThrow("Paperclip POST failed: 500");

    const logs = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain('"errorClass":"paperclip_http_5xx"');
    expect(logs).not.toContain("Sensitive Budget Review");
    expect(logs).not.toContain("lead@example.gov");
  });
});
