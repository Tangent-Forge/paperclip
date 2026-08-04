import pc from "picocolors";

export function printKimiStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trimEnd();
  if (!line) return;
  if (line.startsWith("{")) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.role === "assistant" && typeof obj.content === "string") {
        console.log(pc.green(obj.content));
        return;
      }
      if (obj.role === "meta") {
        console.log(pc.blue(`[meta] ${String(obj.type ?? "")} ${String(obj.session_id ?? "")}`));
        return;
      }
    } catch {
      // fall through
    }
  }
  if (debug || line.startsWith("[")) {
    console.log(pc.gray(line));
  }
}
