import pc from "picocolors";

export function printQwenStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trimEnd();
  if (!line) return;
  if (line.startsWith("{")) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.result === "string") {
        console.log(pc.green(obj.result));
        return;
      }
      if (obj.role === "assistant" && typeof obj.content === "string") {
        console.log(pc.green(obj.content));
        return;
      }
    } catch {
      // fall through
    }
  }
  if (debug || line.startsWith("[")) console.log(pc.gray(line));
}
