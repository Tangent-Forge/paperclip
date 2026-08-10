import { describe, expect, it, vi } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";

const mockRead = vi.hoisted(() => vi.fn());

vi.mock("../services/run-log-store.js", () => ({
  getRunLogStore: () => ({ read: mockRead }),
}));

import { heartbeatService } from "../services/heartbeat.ts";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-b...alue",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });
});

describe("heartbeat run log service", () => {
  it("returns unavailable when log metadata is missing and scopes log access by company", async () => {
    const rows = [{
      id: "run-1",
      companyId: "company-1",
      logStore: null,
      logRef: null,
    }];
    const query = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    const db = {
      select: vi.fn().mockReturnValue(query),
      execute: vi.fn().mockResolvedValue([]),
    } as any;
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.readLog("run-1");

    expect(result).toMatchObject({
      runId: "run-1",
      store: null,
      logRef: null,
      content: "",
      logStatus: "unavailable",
    });
    expect((result as any).note).toContain("Run log not available");
    expect(db.select).toHaveBeenCalled();
    expect(query.where).toHaveBeenCalled();
  });

  it("returns unavailable when the referenced log cannot be read", async () => {
    mockRead.mockRejectedValueOnce(new Error("ENOENT: missing log file"));
    const rows = [{
      id: "run-2",
      companyId: "company-1",
      logStore: "local_file",
      logRef: "logs/run-2.ndjson",
    }];
    const query = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    const db = {
      select: vi.fn().mockReturnValue(query),
      execute: vi.fn().mockResolvedValue([]),
    } as any;
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.readLog("run-2", { offset: 4, limitBytes: 128 });

    expect(result).toMatchObject({
      runId: "run-2",
      store: "local_file",
      logRef: "logs/run-2.ndjson",
      content: "",
      logStatus: "unavailable",
    });
    expect((result as any).note).toContain("Run log read failed");
    expect(mockRead).toHaveBeenCalledWith(
      { store: "local_file", logRef: "logs/run-2.ndjson" },
      { offset: 4, limitBytes: 128 },
    );
  });
});
