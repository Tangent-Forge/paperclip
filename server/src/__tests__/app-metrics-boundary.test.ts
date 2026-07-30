import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";

vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: () => ({}),
}));

vi.mock("../services/plugin-job-scheduler.js", () => ({
  createPluginJobScheduler: () => ({ start: vi.fn(), stop: vi.fn() }),
}));

vi.mock("../services/plugin-job-store.js", () => ({
  pluginJobStore: () => ({}),
}));

vi.mock("../services/plugin-tool-dispatcher.js", () => ({
  createPluginToolDispatcher: () => ({
    initialize: vi.fn(async () => undefined),
  }),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({ load: vi.fn(async () => undefined) }),
}));

vi.mock("../services/plugin-loader.js", () => ({
  DEFAULT_LOCAL_PLUGIN_DIR: "/tmp/paperclip-test-plugins",
  REPO_ROOT: "/tmp/paperclip-test-repo",
  getPluginUiContributionMetadata: vi.fn(() => []),
  listMissingDeclaredPluginEntrypoints: vi.fn(async () => []),
  pluginLoader: () => ({
    installPlugin: vi.fn(async () => ({ manifest: null })),
    loadAll: vi.fn(async () => ({ results: [] })),
  }),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getById: vi.fn(async () => null),
    getByKey: vi.fn(async () => null),
  }),
}));

vi.mock("../services/plugin-event-bus.js", () => ({
  createPluginEventBus: () => ({}),
}));

vi.mock("../services/plugin-job-coordinator.js", () => ({
  createPluginJobCoordinator: () => ({ start: vi.fn(), stop: vi.fn() }),
}));

vi.mock("../services/plugin-host-services.js", () => ({
  buildHostServices: vi.fn(),
  flushPluginLogBuffer: vi.fn(async () => undefined),
}));

vi.mock("../services/plugin-host-service-cleanup.js", () => ({
  createPluginHostServiceCleanup: () => ({
    disposeAll: vi.fn(),
    teardown: vi.fn(),
  }),
}));

vi.mock("../services/plugin-dev-watcher.js", () => ({
  createPluginDevWatcher: () => null,
}));

function createDbStub(): Db {
  return {
    select: vi.fn(),
    execute: vi.fn(),
  } as unknown as Db;
}

function createStorageStub(): StorageService {
  return {} as StorageService;
}

async function createPrivateAuthenticatedApp() {
  const { createApp } = await import("../app.js");
  const app = await createApp(createDbStub(), {
    uiMode: "none",
    serverPort: 3100,
    storageService: createStorageStub(),
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    allowedHostnames: [],
    bindHost: "0.0.0.0",
    authReady: true,
    companyDeletionEnabled: true,
  });
  return app;
}

describe("GET /api/health/metrics createApp boundary", () => {
  it("allows local Prometheus scraping through the guarded health route", async () => {
    const app = await createPrivateAuthenticatedApp();

    const res = await request(app)
      .get("/api/health/metrics")
      .set("Host", "localhost:3100");

    expect(res.status).toBe(200);
    expect(res.text).toContain("# TYPE paperclip_edge_requests_total counter");
    expect(res.text).toContain('paperclip_edge_requests_total{status_class="2xx"}');
  });

  it("blocks disallowed private authenticated hostnames before returning metrics", async () => {
    const app = await createPrivateAuthenticatedApp();

    const res = await request(app)
      .get("/api/health/metrics")
      .set("Host", "unapproved.example.test:3100");

    expect(res.status).toBe(403);
    expect(res.text).not.toContain("paperclip_edge_requests_total");
  });
});
