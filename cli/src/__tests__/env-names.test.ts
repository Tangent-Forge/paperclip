import { describe, expect, it } from "vitest";
import { collectEnvNameInventory } from "../commands/env.js";

describe("env:names command helpers", () => {
  it("returns variable names without values", () => {
    const inventory = collectEnvNameInventory({
      OPENAI_API_KEY: "openai-value-not-printed",
      PAPERCLIP_API_URL: "http://localhost:3100",
      SAFE_FLAG: "visible-value-not-printed",
    });

    expect(inventory.names).toEqual([
      "OPENAI_API_KEY",
      "PAPERCLIP_API_URL",
      "SAFE_FLAG",
    ]);
    expect(JSON.stringify(inventory)).not.toContain("openai-value-not-printed");
    expect(JSON.stringify(inventory)).not.toContain("visible-value-not-printed");
  });

  it("can filter to sensitive-looking variable names only", () => {
    const inventory = collectEnvNameInventory({
      OPENAI_API_KEY: "openai-value-not-printed",
      PAPERCLIP_AGENT_JWT_SECRET: "jwt-test-value-not-printed",
      PAPERCLIP_API_URL: "http://localhost:3100",
    }, { sensitiveOnly: true });

    expect(inventory.names).toEqual([
      "OPENAI_API_KEY",
      "PAPERCLIP_AGENT_JWT_SECRET",
    ]);
    expect(inventory.sensitiveNameMatches).toEqual(inventory.names);
    expect(JSON.stringify(inventory)).not.toContain("jwt-test-value-not-printed");
  });
});
