import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterModel } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);
let cache: { expiresAt: number; models: AdapterModel[] } | null = null;

function dedupe(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const id = model.id.trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function parseDevinModelsJson(input: string): AdapterModel[] {
  const payload = JSON.parse(input) as { families?: unknown };
  if (!Array.isArray(payload.families)) return [];
  const result: AdapterModel[] = [];
  for (const family of payload.families) {
    if (!family || typeof family !== "object") continue;
    const variants = (family as { variants?: unknown }).variants;
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object") continue;
      const record = variant as { model_uid?: unknown; label?: unknown };
      if (typeof record.model_uid !== "string") continue;
      result.push({
        id: record.model_uid,
        label: typeof record.label === "string" && record.label.trim() ? record.label : record.model_uid,
      });
    }
  }
  return dedupe(result);
}

export async function listDevinModels(forceRefresh = false): Promise<AdapterModel[]> {
  if (!forceRefresh && cache && cache.expiresAt > Date.now()) return cache.models;
  try {
    const result = await execFileAsync("devin", ["models", "list", "--format", "json"], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    const models = parseDevinModelsJson(result.stdout);
    if (models.length > 0) {
      cache = { expiresAt: Date.now() + 60_000, models };
    }
    return models;
  } catch {
    return cache?.models ?? [];
  }
}
