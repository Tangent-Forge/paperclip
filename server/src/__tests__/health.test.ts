import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";
import type { SystemMetricsSnapshot } from "../services/system-metrics.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

const mockMetrics: SystemMetricsSnapshot = {
  collectedAt: "2026-07-11T00:00:00.000Z",
  host: {
    hostname: "test-host",
    platform: "linux",
    arch: "x64",
    uptimeSeconds: 123,
    loadAverage: { "1m": 0.1, "5m": 0.2, "15m": 0.3 },
    cpuCount: 4,
    memory: {
      totalBytes: 1000,
      freeBytes: 400,
      usedBytes: 600,
      processRssBytes: 100,
      processHeapUsedBytes: 50,
      processHeapTotalBytes: 80,
    },
    disk: {
      path: "/workspace",
      totalBytes: 2000,
      freeBytes: 1500,
      usedBytes: 500,
    },
  },
  container: {
    detected: true,
    cgroupVersion: "v2",
    memory: {
      currentBytes: 300,
      limitBytes: 900,
    },
    cpu: {
      quotaCores: 2,
      usageSeconds: 10,
      throttledPeriods: 1,
    },
  },
  edge: {
    startedAt: "2026-07-11T00:00:00.000Z",
    uptimeSeconds: 1,
    requestCount: 7,
    inflightRequestCount: 0,
    statusClasses: { "2xx": 6, "5xx": 1 },
    methods: { GET: 7 },
    latencyMs: {
      count: 7,
      avg: 12,
      max: 40,
    },
  },
};

function createApp(db?: Db) {
  const app = express();
  app.use("/health", healthRoutes(db, {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
    collectSystemMetrics: () => mockMetrics,
  }));
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable"
    });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        collectSystemMetrics: () => mockMetrics,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        collectSystemMetrics: () => mockMetrics,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-1", source: "session" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        collectSystemMetrics: () => mockMetrics,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
    });
  });

  it("returns Prometheus host, container, and edge metrics to authorized health callers", async () => {
    const app = createApp();

    const res = await request(app).get("/health/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("# HELP paperclip_host_uptime_seconds");
    expect(res.text).toContain("paperclip_host_uptime_seconds 123");
    expect(res.text).toContain('paperclip_host_memory_bytes{state="process_rss"} 100');
    expect(res.text).toContain('paperclip_host_disk_bytes{path="/workspace",state="used"} 500');
    expect(res.text).toContain('paperclip_container_detected{cgroup_version="v2"} 1');
    expect(res.text).toContain('paperclip_container_memory_bytes{state="current"} 300');
    expect(res.text).toContain("paperclip_container_cpu_quota_cores 2");
    expect(res.text).toContain("paperclip_edge_requests_total 7");
    expect(res.text).toContain('paperclip_edge_requests_total{method="GET"} 7');
    expect(res.text).toContain('paperclip_edge_requests_total{status_class="5xx"} 1');
    expect(res.text).toContain("paperclip_edge_request_latency_milliseconds_count 7");
    expect(res.text).toContain("paperclip_edge_request_latency_milliseconds_sum 84");
  });

  it("rejects anonymous metrics requests in authenticated mode", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(undefined, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        collectSystemMetrics: () => mockMetrics,
      }),
    );

    const res = await request(app).get("/health/metrics");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "health_metrics_auth_required" });
  });
});
