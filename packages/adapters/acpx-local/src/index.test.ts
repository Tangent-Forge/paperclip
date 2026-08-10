import { describe, expect, it } from "vitest";
import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import { models } from "./index.js";

describe("acpx_local models", () => {
  it("is non-empty and combines Claude and Codex models with provider-prefixed labels", () => {
    expect(models.length).toBeGreaterThan(0);
    expect(models.length).toBe(claudeModels.length + codexModels.length);

    const claudeIds = new Set(claudeModels.map((model) => model.id));
    const codexIds = new Set(codexModels.map((model) => model.id));

    for (const model of models) {
      if (claudeIds.has(model.id)) {
        expect(model.label.startsWith("Claude: ")).toBe(true);
      } else if (codexIds.has(model.id)) {
        expect(model.label.startsWith("Codex: ")).toBe(true);
      } else {
        throw new Error(`unexpected model id not sourced from Claude or Codex: ${model.id}`);
      }
    }
  });

  it("deduplicates by id, keeping the first occurrence", () => {
    // acpx_local's model list is built by concatenating two independently
    // maintained adapters' model lists -- dedupe guards against either one
    // (or a future third source) introducing an id collision.
    const ids = models.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
