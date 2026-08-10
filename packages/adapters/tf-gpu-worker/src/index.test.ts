import { describe, expect, it } from "vitest";
import { adapter, createServerAdapter } from "./index.js";

describe("TF-007 worker adapter", () => {
  it("exports the external adapter factory and bounded type", () => {
    expect(createServerAdapter().type).toBe("tf_gpu_worker");
    expect(adapter.models).toEqual([]);
  });

  it("defaults to disabled and exposes the worker safety configuration", async () => {
    const schema = await Promise.resolve(adapter.getConfigSchema?.());
    expect(schema?.fields.some((field) => field.key === "enabled" && field.default === false)).toBe(true);
    expect(schema?.fields.some((field) => field.key === "fallbackPolicy" && field.default === "queue")).toBe(true);
  });
});
