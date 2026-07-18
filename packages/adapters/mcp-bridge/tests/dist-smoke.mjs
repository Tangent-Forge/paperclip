import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const packageRoot = resolve(new URL("..", import.meta.url).pathname);
const rootModule = await import(pathToFileURL(resolve(packageRoot, "dist/index.js")).href);
const serverModule = await import(pathToFileURL(resolve(packageRoot, "dist/server/index.js")).href);

assert.equal(typeof rootModule.createServerAdapter, "function");
assert.equal(typeof rootModule.detectModel, "function");
assert.equal(typeof serverModule.createServerAdapter, "function");
assert.equal(rootModule.type, "mcp_bridge");
assert.equal(serverModule.type, "mcp_bridge");

const adapterFromRoot = rootModule.createServerAdapter();
const adapterFromServer = serverModule.createServerAdapter();

for (const adapter of [adapterFromRoot, adapterFromServer]) {
  assert.equal(adapter.type, "mcp_bridge");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.testEnvironment, "function");
  assert.equal(typeof adapter.detectModel, "function");
  assert.deepEqual(adapter.models, []);
  assert.ok(adapter.agentConfigurationDoc.includes("Adapter: mcp_bridge"));

  const envResult = await adapter.testEnvironment({
    companyId: "company-1",
    adapterType: adapter.type,
    config: {},
  });
  assert.equal(envResult.status, "warn");
  assert.equal(envResult.checks[0]?.level, "warn");
  assert.equal(envResult.checks[0]?.code, "mcp_bridge_process_mode");

  const execResult = await adapter.execute({
    config: {},
    context: {},
  });
  assert.equal(execResult.errorCode, "mcp_bridge_not_implemented");
  assert.equal(execResult.resultJson?.implemented, false);
}

const detectModelResult = await rootModule.detectModel();
assert.equal(detectModelResult, null);
