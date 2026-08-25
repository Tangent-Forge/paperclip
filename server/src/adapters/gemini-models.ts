import { spawn } from "node:child_process";
import path from "node:path";
import type { AdapterModel } from "./types.js";
import { models as geminiFallbackModels } from "@paperclipai/adapter-gemini-local";

const DISCOVERY_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;
const DEFAULT_COMMAND = "agy";

export type GeminiModelDiscoveryContext = {
  command?: string | null;
  env?: NodeJS.ProcessEnv;
  cacheScope?: GeminiModelCacheScope;
};

export type GeminiModelCacheScope = {
  companyId: string;
  principalId: string;
  providerAccountFingerprint: string;
  cacheable?: boolean;
};

type ModelsRunner = (command: string, env: NodeJS.ProcessEnv) => Promise<string>;

type GeminiModelCacheKey = {
  version: 1;
  companyId: string;
  principalId: string;
  providerAccountFingerprint: string;
  command: string;
  home: string;
};

type GeminiModelCacheEntry = { key: GeminiModelCacheKey; expiresAt: number; models: AdapterModel[] };

const MAX_CACHE_ENTRIES = 128;
let cache = new Map<string, GeminiModelCacheEntry>();
let runner: ModelsRunner = runModelList;
let now = () => Date.now();

function isAgy(command: string): boolean {
  return path.basename(command).toLowerCase().replace(/\.(cmd|exe)$/, "") === "agy";
}

function dedupe(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const id = model.id.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: model.label.trim() || id }];
  });
}

export function humanizeGeminiModelId(id: string): string {
  return id
    .split("-")
    .map((part) => {
      if (/^\d+b$/i.test(part)) return part.toUpperCase();
      if (part === "gpt") return "GPT";
      if (part === "oss") return "OSS";
      return /^\d+(\.\d+)?$/.test(part) ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
    })
    .join(" ")
    .replace(/\b(\d+) (\d+)\b/g, "$1.$2");
}

export function parseAgyModelList(stdout: string): AdapterModel[] {
  return dedupe(stdout.split(/\r?\n/).flatMap((raw) => {
    const [id, ...labelParts] = raw.trim().split(/\s+/);
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || !/[-.]/.test(id)) return [];
    return [{ id, label: labelParts.join(" ") || humanizeGeminiModelId(id) }];
  }));
}

function runModelList(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["models"], { env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => {
      child.kill("SIGTERM");
      reject(new Error(`agy models timed out after ${DISCOVERY_TIMEOUT_MS}ms`));
    }), DISCOVERY_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2 * 1024 * 1024) {
        finish(() => {
          child.kill("SIGTERM");
          reject(new Error("agy models output exceeded buffer"));
        });
      }
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => code === 0 ? resolve(stdout) : reject(new Error(`agy models exited ${code}`))));
  });
}

async function loadModels({ forceRefresh = false, context }: { forceRefresh?: boolean; context?: GeminiModelDiscoveryContext } = {}) {
  const command = context?.command?.trim() || DEFAULT_COMMAND;
  const fallback = dedupe(geminiFallbackModels);
  if (!isAgy(command)) return fallback;
  const env = { ...process.env, ...(context?.env ?? {}) };
  const scope = context?.cacheScope;
  const keyObject: GeminiModelCacheKey | null = scope && scope.cacheable !== false
    && scope.companyId.trim().length > 0
    && scope.principalId.trim().length > 0
    && scope.providerAccountFingerprint.trim().length > 0
    ? {
        version: 1,
        companyId: scope.companyId,
        principalId: scope.principalId,
        providerAccountFingerprint: scope.providerAccountFingerprint,
        command,
        home: env.HOME ?? "",
      }
    : null;
  const key = keyObject ? JSON.stringify(keyObject) : null;
  const currentTime = now();
  const cached = key ? cache.get(key) : undefined;
  if (!forceRefresh && cached && cached.expiresAt > currentTime) return cached.models;
  try {
    const discovered = parseAgyModelList(await runner(command, env));
    if (discovered.length > 0) {
      if (key && keyObject) {
        cache.set(key, { key: keyObject, expiresAt: currentTime + CACHE_TTL_MS, models: discovered });
        for (const [entryKey, entry] of cache) {
          if (entry.expiresAt <= currentTime) cache.delete(entryKey);
        }
        while (cache.size > MAX_CACHE_ENTRIES) {
          const oldestKey = cache.keys().next().value as string | undefined;
          if (!oldestKey) break;
          cache.delete(oldestKey);
        }
      }
      return discovered;
    }
  } catch {
    // Discovery is optional; keep the static upstream catalog on auth/offline errors.
  }
  return cached && cached.expiresAt > currentTime && cached.models.length > 0 ? cached.models : fallback;
}

export const listGeminiModelsForContext = (context: GeminiModelDiscoveryContext) => loadModels({ context });
export const refreshGeminiModelsForContext = (context: GeminiModelDiscoveryContext) => loadModels({ forceRefresh: true, context });

export function resetGeminiModelsCacheForTests(): void { cache.clear(); now = () => Date.now(); }
export function setGeminiModelsRunnerForTests(next: ModelsRunner): void { runner = next; }
export function resetGeminiModelsRunnerForTests(): void { runner = runModelList; }
export function setGeminiModelsClockForTests(next: () => number): void { now = next; }
