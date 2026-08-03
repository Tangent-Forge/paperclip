import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AdapterModel } from "./types.js";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";

const CODEX_APP_SERVER_TIMEOUT_MS = 8000;
const CODEX_MODELS_CACHE_TTL_MS = 60_000;
const DEFAULT_CODEX_COMMAND = "codex";

type CodexModelListEntry = {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
};

type CodexAppServerRunner = (command: string, env: NodeJS.ProcessEnv) => Promise<unknown[]>;

export type CodexModelDiscoveryContext = {
  command?: string | null;
  env?: NodeJS.ProcessEnv;
};

let cached: { key: string; expiresAt: number; models: AdapterModel[] } | null = null;
let appServerRunner: CodexAppServerRunner = runCodexAppServerModelList;

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

function mapCodexModels(entries: unknown[]): AdapterModel[] {
  return dedupeModels(entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as CodexModelListEntry;
    if (item.hidden === true) return [];
    const id = typeof item.id === "string" ? item.id : item.model;
    if (typeof id !== "string" || id.trim().length === 0) return [];
    const label = typeof item.displayName === "string" ? item.displayName : id;
    return [{ id, label }];
  }));
}

function codexCommand(context?: CodexModelDiscoveryContext): string {
  return context?.command?.trim() || process.env.CODEX_COMMAND?.trim() || DEFAULT_CODEX_COMMAND;
}

function discoveryKey(command: string, env: NodeJS.ProcessEnv): string {
  return `${command}\u0000${env.CODEX_HOME ?? ""}`;
}

function closeChild(child: ChildProcessWithoutNullStreams): void {
  if (!child.killed) child.kill("SIGTERM");
}

async function runCodexAppServerModelList(command: string, env: NodeJS.ProcessEnv): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      readline.close();
      closeChild(child);
      fn();
    };
    const timeout = setTimeout(() => finish(() => reject(new Error("Codex app-server model discovery timed out"))), CODEX_APP_SERVER_TIMEOUT_MS);
    const readline = createInterface({ input: child.stdout });

    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "paperclip", version: "1.0" }, capabilities: {} } });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} });

    readline.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id?: unknown; result?: { data?: unknown } };
        if (message.id !== 2) return;
        const data = message.result?.data;
        finish(() => resolve(Array.isArray(data) ? data : []));
      } catch {
        // Ignore notifications and malformed non-response lines. Timeout is the failure boundary.
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`Codex app-server exited with code ${code ?? "unknown"}`)));
    });
  });
}

async function loadCodexModels(
  options?: { forceRefresh?: boolean; context?: CodexModelDiscoveryContext },
): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const context = options?.context;
  const command = codexCommand(context);
  const env = { ...process.env, ...(context?.env ?? {}) };
  const key = discoveryKey(command, env);
  const fallback = dedupeModels(codexFallbackModels);
  const now = Date.now();
  if (!forceRefresh && cached && cached.key === key && cached.expiresAt > now) return cached.models;

  try {
    const discovered = mapCodexModels(await appServerRunner(command, env));
    if (discovered.length > 0) {
      cached = { key, expiresAt: now + CODEX_MODELS_CACHE_TTL_MS, models: discovered };
      return discovered;
    }
  } catch {
    // Explicit failure fallback: preserve the static catalog only when OAuth discovery fails.
  }

  if (cached && cached.key === key && cached.models.length > 0) return cached.models;
  return fallback;
}

export async function listCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels();
}

export async function listCodexModelsForContext(context: CodexModelDiscoveryContext): Promise<AdapterModel[]> {
  return loadCodexModels({ context });
}

export async function refreshCodexModels(): Promise<AdapterModel[]> {
  return loadCodexModels({ forceRefresh: true });
}

export async function refreshCodexModelsForContext(context: CodexModelDiscoveryContext): Promise<AdapterModel[]> {
  return loadCodexModels({ forceRefresh: true, context });
}

export function resetCodexModelsCacheForTests() {
  cached = null;
}

export function setCodexAppServerRunnerForTests(runner: CodexAppServerRunner): void {
  appServerRunner = runner;
}

export function resetCodexAppServerRunnerForTests(): void {
  appServerRunner = runCodexAppServerModelList;
}
