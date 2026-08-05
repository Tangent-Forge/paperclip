export function parseQwenOutput(stdout: string, format: "text" | "json" | "stream-json"): {
  sessionId: string | null;
  summary: string | null;
  errorMessage: string | null;
} {
  let sessionId: string | null = null;
  const assistantChunks: string[] = [];
  let errorMessage: string | null = null;

  if (format === "text") {
    const m = stdout.match(/session[_ -]?id[:\s]+([A-Za-z0-9_-]+)/i);
    if (m?.[1]) sessionId = m[1];
    const summary = stdout.trim() || null;
    return { sessionId, summary, errorMessage };
  }

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      // stream-json / json shapes vary; collect common fields
      if (typeof obj.session_id === "string" && obj.session_id.trim()) sessionId = obj.session_id.trim();
      if (typeof obj.sessionId === "string" && obj.sessionId.trim()) sessionId = obj.sessionId.trim();
      if (obj.type === "result") {
        if (typeof obj.result === "string" && obj.result.trim()) {
          assistantChunks.push(obj.result);
        }
        if (obj.is_error === true || obj.subtype === "error") {
          const msg =
            (typeof obj.result === "string" && obj.result) ||
            (typeof obj.message === "string" && obj.message) ||
            "Qwen CLI result error";
          errorMessage = msg;
        }
      }
      if (obj.type === "assistant" || obj.role === "assistant") {
        const message = obj.message;
        const content =
          obj.content ??
          obj.text ??
          (message && typeof message === "object"
            ? (message as Record<string, unknown>).content
            : message);
        if (typeof content === "string") assistantChunks.push(content);
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (part && typeof part === "object") {
              const p = part as Record<string, unknown>;
              if (p.type === "text" && typeof p.text === "string") assistantChunks.push(p.text);
            }
          }
        } else if (content && typeof content === "object") {
          const c = content as Record<string, unknown>;
          if (typeof c.text === "string") assistantChunks.push(c.text);
        }
      }
      if (obj.type === "error" || (obj.error && obj.type !== "result")) {
        const msg =
          (typeof obj.message === "string" && obj.message) ||
          (typeof obj.error === "string" && obj.error) ||
          null;
        if (msg) errorMessage = msg;
      }
    } catch {
      // ignore
    }
  }

  // whole-stdout json
  if (!assistantChunks.length) {
    try {
      const obj = JSON.parse(stdout) as Record<string, unknown>;
      if (typeof obj.result === "string") assistantChunks.push(obj.result);
      if (typeof obj.session_id === "string") sessionId = obj.session_id;
    } catch {
      // ignore
    }
  }

  return {
    sessionId,
    summary: assistantChunks.join("\n").trim() || null,
    errorMessage,
  };
}

/**
 * Detect real Qwen Code CLI auth failures — NOT agent narrative that mentions
 * BAILIAN_* / auth while reporting configuration (that caused false AUTH_REQUIRED
 * on successful runs that discussed credentials).
 */
export function detectQwenAuthRequired(text: string): boolean {
  return (
    /Missing API key for OpenAI-compatible auth/i.test(text) ||
    /No auth type is selected\.?\s*Please configure an auth type/i.test(text) ||
    /please configure an auth type \(e\.g\. via settings/i.test(text) ||
    /invalid_authentication_error/i.test(text) ||
    /Invalid Authentication/i.test(text) ||
    /Authentication failed/i.test(text)
  );
}

/** True when stream-json ends with a successful result event. */
export function detectQwenStreamSuccess(stdout: string): boolean {
  // Prefer last result line
  const lines = stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type === "result") {
        return obj.subtype === "success" || obj.is_error === false;
      }
    } catch {
      // continue
    }
  }
  return false;
}

export function isQwenUnknownSessionError(text: string): boolean {
  return /session not found|unknown session|invalid session|no such session/i.test(text);
}
