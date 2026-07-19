import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, vi } from "vitest";

vi.mock("../../../../server/src/middleware/logger.js", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

vi.mock("../../../../server/src/services/adapter-plugin-store.js", () => ({
  listAdapterPlugins: () => [],
  getAdapterPluginsDir: () => "",
  getAdapterPluginByType: () => null,
}));

describe("external adapter source-loader contract", () => {
  it("loads the built package through the real external adapter loader", async () => {
    const { loadExternalAdapterPackage } = await import(
      "../../../../server/src/adapters/plugin-loader.js"
    );

    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const adapterModule = await loadExternalAdapterPackage(
      "@tangent-forge/paperclip-mcp-adapter",
      packageRoot,
    );

    assert.equal(adapterModule.type, "mcp_bridge");
    assert.equal(typeof adapterModule.execute, "function");
    assert.equal(typeof adapterModule.testEnvironment, "function");
    assert.equal(typeof adapterModule.detectModel, "function");
    assert.equal(adapterModule.models.length, 0);
    assert.ok(adapterModule.agentConfigurationDoc.includes("Adapter: mcp_bridge"));

    const directModule = await import(pathToFileURL(path.join(packageRoot, "dist/index.js")).href);
    assert.equal(typeof directModule.createServerAdapter, "function");
    assert.equal(directModule.createServerAdapter().type, "mcp_bridge");
  });
});
