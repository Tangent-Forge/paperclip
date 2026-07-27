import type { CreateConfigValues } from "../../components/AgentConfigForm";

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Leave invalid JSON out of the saved config; the field keeps the draft visible.
  }

  return undefined;
}

export function buildHttpConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  const headers = parseJsonObject(v.headersJson ?? "");
  if (headers) ac.headers = headers;
  const payloadTemplate = parseJsonObject(v.payloadTemplateJson ?? "");
  if (payloadTemplate) ac.payloadTemplate = payloadTemplate;
  ac.method = "POST";
  ac.timeoutMs = 15000;
  return ac;
}
