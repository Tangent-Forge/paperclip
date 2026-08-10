import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseQwenStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "result" && typeof obj.result === "string") {
        return [{ kind: "assistant", ts, text: obj.result }];
      }
      if (obj.role === "assistant" || obj.type === "assistant") {
        const text =
          (typeof obj.content === "string" && obj.content) ||
          (typeof obj.text === "string" && obj.text) ||
          "";
        if (text) return [{ kind: "assistant", ts, text }];
      }
    } catch {
      // fall through
    }
  }
  if (trimmed.startsWith("[qwen]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
