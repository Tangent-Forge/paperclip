import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { redactSensitiveText } from "../redaction.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export type RunLogRemediationAction = "redact" | "purge";

export interface RunLogRemediationSummary {
  action: RunLogRemediationAction;
  bytesBefore: number;
  bytesAfter: number;
  sha256?: string;
  compressed: boolean;
  redactedChunks: number;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
  remediate(
    handle: RunLogHandle,
    input: { action: RunLogRemediationAction; redactText: (text: string) => string },
  ): Promise<RunLogRemediationSummary>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
      // Defense-in-depth write-path scrub: never persist credential-shaped output
      // even if a caller skipped compactRunLogChunk.
      const scrubbedChunk = redactSensitiveText(event.chunk);
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: scrubbedChunk,
      });
      const persisted = `${line}\n`;
      await fs.appendFile(absPath, persisted, "utf8");
      return Buffer.byteLength(persisted, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },

    async remediate(handle, input) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const statBefore = await fs.stat(absPath).catch(() => null);
      if (!statBefore) throw notFound("Run log not found");

      let redactedChunks = 0;
      if (input.action === "purge") {
        await fs.writeFile(absPath, "", "utf8");
      } else {
        const before = await fs.readFile(absPath, "utf8");
        const after = before
          .split("\n")
          .map((line) => {
            if (line.length === 0) return line;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (typeof parsed.chunk !== "string") return line;
              const chunk = input.redactText(parsed.chunk);
              if (chunk !== parsed.chunk) redactedChunks += 1;
              return JSON.stringify({ ...parsed, chunk });
            } catch {
              const redactedLine = input.redactText(line);
              if (redactedLine !== line) redactedChunks += 1;
              return redactedLine;
            }
          })
          .join("\n");
        await fs.writeFile(absPath, after, "utf8");
      }

      const statAfter = await fs.stat(absPath);
      const hash = await sha256File(absPath);
      return {
        action: input.action,
        bytesBefore: statBefore.size,
        bytesAfter: statAfter.size,
        sha256: hash,
        compressed: false,
        redactedChunks,
      };
    },
  };
}

let cachedStore: RunLogStore | null = null;
let cachedBasePath: string | null = null;

export function getRunLogStore() {
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  if (cachedStore && cachedBasePath === basePath) return cachedStore;
  cachedStore = createLocalFileRunLogStore(basePath);
  cachedBasePath = basePath;
  return cachedStore;
}

export function resetRunLogStoreForTests() {
  cachedStore = null;
  cachedBasePath = null;
}
