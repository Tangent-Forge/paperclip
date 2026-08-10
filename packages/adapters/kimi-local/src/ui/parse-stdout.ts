import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseKimiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.role === "assistant" && typeof obj.content === "string") {
        return [{ kind: "assistant", ts, text: obj.content }];
      }
      if (obj.role === "meta" && obj.type === "session.resume_hint") {
        return [
          {
            kind: "system",
            ts,
            text: `session ${String(obj.session_id ?? "")}`,
          },
        ];
      }
    } catch {
      // fall through
    }
  }
  if (trimmed.startsWith("[kimi]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
