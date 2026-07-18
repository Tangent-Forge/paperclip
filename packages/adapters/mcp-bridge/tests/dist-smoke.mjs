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
  assert.ok(adapter.agentConfigurationDoc.includes('command (string, required): executable path only'));

  const envInvalid = await adapter.testEnvironment({
    companyId: "company-1",
    adapterType: adapter.type,
    config: { mode: "process", command: "", toolName: "echo" },
  });
  assert.equal(envInvalid.status, "fail");
  assert.equal(envInvalid.checks[0]?.level, "error");
  assert.equal(envInvalid.checks[0]?.code, "mcp_bridge_process_mode");

  const envValid = await adapter.testEnvironment({
    companyId: "company-1",
    adapterType: adapter.type,
    config: { mode: "process", command: process.execPath, toolName: "echo" },
  });
  assert.equal(envValid.status, "warn");
  assert.equal(envValid.checks[0]?.level, "warn");
  assert.equal(envValid.checks[0]?.code, "mcp_bridge_process_mode");

  const execResult = await adapter.execute({
    runId: "run-smoke",
    agent: { id: "agent-1", companyId: "company-1", name: "Smoke", adapterType: adapter.type, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { mode: "process", command: "", toolName: "echo" },
    context: {},
    onLog: async () => {},
  });
  assert.equal(execResult.errorCode, "mcp_bridge_invalid_config");
  assert.equal(execResult.resultJson?.ok, false);
}

const detectModelResult = await rootModule.detectModel();
assert.equal(detectModelResult, null);
