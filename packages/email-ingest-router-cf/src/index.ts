import PostalMime from "postal-mime";

export interface Env {
  PAPERCLIP_TRIGGER_SECRET: string;
  PAPERCLIP_TRIGGER_URL: string;
  DEFAULT_AGENT: string;
  ALLOWED_SENDER_DOMAINS?: string;
  ALLOWED_RECIPIENT_PATTERNS?: string;
}

const AGENT_MAP: Record<string, string> = {
  ceo: "ceo",
  cto: "cto",
  risk: "risk",
  "risk-auditor": "risk",
  hermes: "hermes",
  "hermes-lead": "hermes",
  cos: "cos",
  "chief-of-staff": "cos",
};

const INGEST_RE = /ingest\+([a-z0-9_-]+)@/i;
const LOG_FIELD_LIMIT = 120;

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

export function pickAgent(toHeaderValues: string[], defaultAgent: string): string {
  for (const v of toHeaderValues) {
    if (!v) continue;
    const m = INGEST_RE.exec(v);
    if (m) {
      const tag = m[1].toLowerCase();
      return AGENT_MAP[tag] ?? defaultAgent;
    }
  }
  return defaultAgent;
}

export function sortObjectKeys<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys) as unknown as T;
  if (obj && typeof obj === "object") {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce((acc, k) => {
        (acc as Record<string, unknown>)[k] = sortObjectKeys(
          (obj as Record<string, unknown>)[k],
        );
        return acc;
      }, {} as Record<string, unknown>) as T;
  }
  return obj;
}

export function truncateForLog(value: string, limit = LOG_FIELD_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

export function buildDeliveryId(messageId: string, from: string, receivedAt: string): string {
  const source = messageId.trim() || `${from.trim()}:${receivedAt.trim()}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `mail_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function logInfo(event: string, fields: Record<string, string | number>) {
  console.log(JSON.stringify({ event, ...fields }));
}

function logError(event: string, fields: Record<string, string | number>) {
  console.error(JSON.stringify({ event, ...fields }));
}

function splitConfigList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emailDomain(value: string): string | null {
  const match = value.match(/@([^>\s]+)>?$/);
  return match?.[1]?.toLowerCase() ?? null;
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return value.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

export function isAllowedSender(from: string, allowedSenderDomains: string[]): boolean {
  if (allowedSenderDomains.length === 0) return true;
  const senderDomain = emailDomain(from);
  return Boolean(senderDomain && allowedSenderDomains.some((domain) => senderDomain === domain || senderDomain.endsWith(`.${domain}`)));
}

export function isAllowedRecipient(recipients: string[], allowedRecipientPatterns: string[]): boolean {
  if (allowedRecipientPatterns.length === 0) return true;
  return matchesAny(recipients.join("\n"), allowedRecipientPatterns);
}

function paperclipErrorClass(status: number): string {
  return status >= 500 ? "paperclip_http_5xx" : "paperclip_http_4xx";
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    const parser = new PostalMime();
    const arrayBuf = await new Response(message.raw).arrayBuffer();
    const parsed = await parser.parse(arrayBuf);

    const toValues: string[] = [
      message.to ?? "",
      ...(parsed.to?.map((a) => a.address ?? "") ?? []),
      ...(parsed.cc?.map((a) => a.address ?? "") ?? []),
    ];
    const agent = pickAgent(toValues, env.DEFAULT_AGENT || "hermes");

    const payload = {
      agent,
      from: parsed.from?.address ?? message.from,
      subject: parsed.subject ?? "",
      body_text: (parsed.text ?? "").slice(0, 50000),
      body_html: (parsed.html ?? "").slice(0, 50000),
      gmail_message_id: parsed.messageId ?? "",
      received_at: parsed.date ?? new Date().toISOString(),
    };
    const deliveryId = buildDeliveryId(
      payload.gmail_message_id,
      payload.from,
      payload.received_at,
    );
    const allowedSenderDomains = splitConfigList(env.ALLOWED_SENDER_DOMAINS).map((domain) => domain.toLowerCase());
    const allowedRecipientPatterns = splitConfigList(env.ALLOWED_RECIPIENT_PATTERNS);
    if (!isAllowedSender(payload.from, allowedSenderDomains) || !isAllowedRecipient(toValues, allowedRecipientPatterns)) {
      logInfo("email_ingest_skipped", {
        deliveryId,
        agent,
        status: "filtered",
      });
      return;
    }

    logInfo("email_ingest_received", {
      deliveryId,
      agent,
      status: "received",
    });

    // Keep this compatible with Python json.dumps(sort_keys=True, separators=(",", ":")).
    const sortedJson = JSON.stringify(sortObjectKeys(payload));
    const ts = Math.floor(Date.now() / 1000).toString();
    // Contract (verified against server/src/services/routines.ts `github_hmac`
    // verification, 2026-08-29): the HMAC covers the RAW BODY ONLY. The
    // previous `${ts}.${body}` signing input matched no server-side mode and
    // produced 401s on every delivery — the timestamp header stays as an
    // informational field the server does not verify.
    const sig = await hmacHex(env.PAPERCLIP_TRIGGER_SECRET, sortedJson);

    const res = await fetch(env.PAPERCLIP_TRIGGER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": deliveryId,
        "X-Paperclip-Timestamp": ts,
        "X-Paperclip-Signature": `sha256=${sig}`,
      },
      body: sortedJson,
    });

    if (!(res.status >= 200 && res.status < 300)) {
      logError("email_ingest_paperclip_post_failed", {
        deliveryId,
        agent,
        status: res.status,
        errorClass: paperclipErrorClass(res.status),
      });
      // Throwing lets Cloudflare Email Routing retry transient delivery failures.
      throw new Error(`Paperclip POST failed: ${res.status}`);
    }
    logInfo("email_ingest_delivered", {
      deliveryId,
      agent,
      status: res.status,
    });
  },
};
