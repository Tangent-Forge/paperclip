import PostalMime from "postal-mime";

export interface Env {
  PAPERCLIP_TRIGGER_SECRET: string;
  PAPERCLIP_TRIGGER_URL: string;
  DEFAULT_AGENT: string;
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

    logInfo("email_ingest_received", {
      deliveryId,
      agent,
      from: truncateForLog(payload.from),
      subject: truncateForLog(payload.subject),
    });

    // Keep this compatible with Python json.dumps(sort_keys=True, separators=(",", ":")).
    const sortedJson = JSON.stringify(sortObjectKeys(payload));
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await hmacHex(env.PAPERCLIP_TRIGGER_SECRET, `${ts}.${sortedJson}`);

    const res = await fetch(env.PAPERCLIP_TRIGGER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Paperclip-Timestamp": ts,
        "X-Paperclip-Signature": `sha256=${sig}`,
      },
      body: sortedJson,
    });

    if (!(res.status >= 200 && res.status < 300)) {
      const text = await res.text();
      logError("email_ingest_paperclip_post_failed", {
        deliveryId,
        agent,
        status: res.status,
        responseBody: truncateForLog(text, 300),
        subject: truncateForLog(payload.subject),
      });
      // Throwing lets Cloudflare Email Routing retry transient delivery failures.
      throw new Error(`Paperclip POST failed: ${res.status}`);
    }
    logInfo("email_ingest_delivered", {
      deliveryId,
      agent,
      status: res.status,
      subject: truncateForLog(payload.subject),
    });
  },
};
