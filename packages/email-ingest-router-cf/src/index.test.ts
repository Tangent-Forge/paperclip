import { describe, expect, it } from "vitest";

import { buildDeliveryId, pickAgent, sortObjectKeys, truncateForLog } from "./index.js";

describe("email ingest router helpers", () => {
  it("routes known ingest tags and falls back for unknown tags", () => {
    expect(pickAgent(["Ops <ingest+cto@tf-hub.dev>"], "hermes")).toBe("cto");
    expect(pickAgent(["ingest+risk-auditor@tf-hub.dev"], "hermes")).toBe("risk");
    expect(pickAgent(["ingest+unknown@tf-hub.dev"], "hermes")).toBe("hermes");
  });

  it("sorts payload keys recursively for signature compatibility", () => {
    expect(sortObjectKeys({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }] })).toEqual({
      a: { b: 3, y: 2 },
      list: [{ c: 5, d: 4 }],
      z: 1,
    });
  });

  it("keeps log values single-line and bounded", () => {
    expect(truncateForLog("  hello\nworld\tagain  ")).toBe("hello world again");
    expect(truncateForLog("abcdef", 4)).toBe("a...");
  });

  it("builds stable non-secret delivery ids", () => {
    const first = buildDeliveryId("<msg@example.com>", "sender@example.com", "2026-06-13T00:00:00Z");
    const second = buildDeliveryId("<msg@example.com>", "other@example.com", "2026-06-14T00:00:00Z");
    const fallback = buildDeliveryId("", "sender@example.com", "2026-06-13T00:00:00Z");

    expect(first).toMatch(/^mail_[0-9a-f]{8}$/);
    expect(second).toBe(first);
    expect(fallback).toMatch(/^mail_[0-9a-f]{8}$/);
    expect(fallback).not.toBe(first);
  });
});
