import { spawn } from "node:child_process";
import path from "node:path";
import type { AdapterModel } from "./types.js";
import { models as geminiFallbackModels } from "@paperclipai/adapter-gemini-local";

const GEMINI_MODELS_TIMEOUT_MS = 8000;
const GEMINI_MODELS_CACHE_TTL_MS = 60_000;
// gemini_local is agy-only as of 2026-08-09; an agent with no explicit command
// should resolve to Antigravity, not the Gemini CLI.
const DEFAULT_GEMINI_COMMAND = "agy";

/**
 * Kept as a guard rather than removed: a misconfigured agent can still point
 * `command` at something that is not agy, and shelling `models` at an arbitrary
 * binary is not a safe default. Non-agy commands fall back to the static catalog.
 */
function isAgy(command: string): boolean {
  return path.basename(command).toLowerCase().replace(/\.(cmd|exe)$/, "") === "agy";
}

export type GeminiModelDiscoveryContext = {
  command?: string | null;
  env?: NodeJS.ProcessEnv;
};

type GeminiModelsRunner = (command: string, env: NodeJS.ProcessEnv) => Promise<string>;

let cached: { key: string; expiresAt: number; models: AdapterModel[] } | null = null;
let modelsRunner: GeminiModelsRunner = runAgyModelList;

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

/**
 * `agy models` emits bare model ids, one per line, with no labels. Build a
 * readable label rather than showing the raw slug in the picker.
 */
export function humanizeGeminiModelId(id: string): string {
  const words = id.split("-").map((part) => {
    if (/^\d+(\.\d+)?$/.test(part)) return part;
    if (part === "gpt") return "GPT";
    if (part === "oss") return "OSS";
    if (/^\d+b$/i.test(part)) return part.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  });
  // Rejoin a dotted version that split on "-" (e.g. "3", "6" -> "3.6").
  return words.join(" ").replace(/\b(\d+) (\d+)\b/g, "$1.$2");
}

/**
 * Handles both shapes agy has emitted:
 *   older:  "gemini-3.6-flash-high"
 *   newer:  "gemini-3.6-flash-high\tGemini 3.6 Flash (High)", preceded by a
 *           "Fetching available models..." banner
 *
 * The original parser required the whole line to be slug-shaped, so when agy
 * started appending labels every line was rejected, nothing parsed, and lookups
 * silently fell back to the static catalog. Take the first field as the id and
 * prefer agy's own label when it supplies one.
 */
export function parseAgyModelList(stdout: string): AdapterModel[] {
  const models: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [id, ...rest] = line.split(/\s+/);
    // Ids are slugs and always contain a separator, which is what distinguishes
    // them from prose lines such as the "Fetching available models..." banner.
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || !/[-.]/.test(id)) continue;
    const label = rest.join(" ").trim();
    models.push({ id, label: label || humanizeGeminiModelId(id) });
  }
  return dedupeModels(models);
}

/**
 * Uses spawn with stdin explicitly ignored rather than execFile.
 *
 * execFile hands the child a stdin pipe, and agy blocks on it forever — the call
 * never returns and is eventually killed by its own timeout, so discovery silently
 * degrades to the static catalog. Measured: execFile is still running at 8s, 30s
 * and 60s, while spawn with stdio ["ignore","pipe","ignore"] exits code 0 in ~1.5s.
 * stderr is discarded because agy emits Go runtime chatter there on every run.
 */
function runAgyModelList(command: string, env: NodeJS.ProcessEnv): Promise<string> {
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
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        reject(new Error(`agy models timed out after ${GEMINI_MODELS_TIMEOUT_MS}ms`));
      });
    }, GEMINI_MODELS_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2 * 1024 * 1024) {
        finish(() => {
          child.kill("SIGTERM");
          reject(new Error("agy models output exceeded buffer"));
        });
      }
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      finish(() => (code === 0 ? resolve(stdout) : reject(new Error(`agy models exited ${code}`))));
    });
  });
}

function geminiCommand(context?: GeminiModelDiscoveryContext): string {
  return context?.command?.trim() || DEFAULT_GEMINI_COMMAND;
}

function discoveryKey(command: string, env: NodeJS.ProcessEnv): string {
  return `${command}\u0000${env.HOME ?? ""}`;
}

async function loadGeminiModels(
  opts: { forceRefresh?: boolean; context?: GeminiModelDiscoveryContext } = {},
): Promise<AdapterModel[]> {
  const { forceRefresh = false, context } = opts;
  const command = geminiCommand(context);
  // Layer the agent's overrides ONTO the process environment rather than replacing
  // it. An agent configured for subscription isolation has `env: {}`, and `{}` is
  // truthy — `context?.env ?? process.env` handed agy a completely empty
  // environment, which it rejects with "$HOME is not defined", silently degrading
  // every lookup to the static catalog. This mirrors what the adapter's own
  // execution path does when it spawns the CLI.
  const env: NodeJS.ProcessEnv = { ...process.env, ...(context?.env ?? {}) };
  const fallback = dedupeModels(geminiFallbackModels);

  if (!isAgy(command)) return fallback;

  const key = discoveryKey(command, env);
  const now = Date.now();
  if (!forceRefresh && cached && cached.key === key && cached.expiresAt > now) return cached.models;

  try {
    const discovered = parseAgyModelList(await modelsRunner(command, env));
    if (discovered.length > 0) {
      cached = { key, expiresAt: now + GEMINI_MODELS_CACHE_TTL_MS, models: discovered };
      return discovered;
    }
  } catch {
    // Discovery failure (agy missing, unauthenticated, offline) falls back to the
    // static catalog rather than emptying the picker.
  }

  if (cached && cached.key === key && cached.models.length > 0) return cached.models;
  return fallback;
}

export async function listGeminiModelsForContext(
  context: GeminiModelDiscoveryContext,
): Promise<AdapterModel[]> {
  return loadGeminiModels({ context });
}

export async function refreshGeminiModelsForContext(
  context: GeminiModelDiscoveryContext,
): Promise<AdapterModel[]> {
  return loadGeminiModels({ forceRefresh: true, context });
}

export function resetGeminiModelsCacheForTests(): void {
  cached = null;
}

export function setGeminiModelsRunnerForTests(runner: GeminiModelsRunner): void {
  modelsRunner = runner;
}

export function resetGeminiModelsRunnerForTests(): void {
  modelsRunner = runAgyModelList;
}
