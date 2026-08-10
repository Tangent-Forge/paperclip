export function parseKimiStreamJson(stdout: string): {
  sessionId: string | null;
  summary: string | null;
  errorMessage: string | null;
} {
  let sessionId: string | null = null;
  const assistantChunks: string[] = [];
  let errorMessage: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.role === "assistant" && typeof obj.content === "string") {
        assistantChunks.push(obj.content);
      }
      if (obj.role === "meta" && obj.type === "session.resume_hint") {
        const sid = obj.session_id ?? obj.sessionId;
        if (typeof sid === "string" && sid.trim()) sessionId = sid.trim();
      }
      if (typeof obj.session_id === "string" && obj.session_id.trim()) {
        sessionId = obj.session_id.trim();
      }
      if (obj.error || obj.type === "error") {
        const msg =
          (typeof obj.message === "string" && obj.message) ||
          (typeof obj.error === "string" && obj.error) ||
          (typeof obj.content === "string" && obj.content) ||
          null;
        if (msg) errorMessage = msg;
      }
    } catch {
      // ignore non-json lines
    }
  }

  // Fallback: text mode resume hint
  if (!sessionId) {
    const m = stdout.match(/kimi\s+-r\s+(session_[A-Za-z0-9_-]+)/);
    if (m?.[1]) sessionId = m[1];
  }

  const summary = assistantChunks.join("\n").trim() || null;
  return { sessionId, summary, errorMessage };
}

export function detectKimiAuthRequired(text: string): boolean {
  return /login required|not authenticated|run [`']?kimi login|unauthorized|invalid.?token|authentication failed/i.test(
    text,
  );
}

export function isKimiUnknownSessionError(text: string): boolean {
  return /session not found|unknown session|invalid session|no such session/i.test(text);
}
