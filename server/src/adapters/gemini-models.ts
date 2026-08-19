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
};

type ModelsRunner = (command: string, env: NodeJS.ProcessEnv) => Promise<string>;

let cache: { key: string; expiresAt: number; models: AdapterModel[] } | null = null;
let runner: ModelsRunner = runModelList;

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
  const key = `${command}\u0000${env.HOME ?? ""}`;
  const now = Date.now();
  if (!forceRefresh && cache?.key === key && cache.expiresAt > now) return cache.models;
  try {
    const discovered = parseAgyModelList(await runner(command, env));
    if (discovered.length > 0) {
      cache = { key, expiresAt: now + CACHE_TTL_MS, models: discovered };
      return discovered;
    }
  } catch {
    // Discovery is optional; keep the static upstream catalog on auth/offline errors.
  }
  return cache?.key === key && cache.models.length > 0 ? cache.models : fallback;
}

export const listGeminiModelsForContext = (context: GeminiModelDiscoveryContext) => loadModels({ context });
export const refreshGeminiModelsForContext = (context: GeminiModelDiscoveryContext) => loadModels({ forceRefresh: true, context });

export function resetGeminiModelsCacheForTests(): void { cache = null; }
export function setGeminiModelsRunnerForTests(next: ModelsRunner): void { runner = next; }
export function resetGeminiModelsRunnerForTests(): void { runner = runModelList; }
