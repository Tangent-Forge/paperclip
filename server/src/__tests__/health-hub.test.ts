import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import type { DeploymentMode } from "@paperclipai/shared";
import { healthRoutes } from "../routes/health.js";

function createApp(opts: { deploymentMode?: DeploymentMode; actorType?: string } = {}) {
  const app = express();
  if (opts.actorType) {
    app.use((req, _res, next) => {
      (req as any).actor = { type: opts.actorType, source: "session" };
      next();
    });
  }
  app.use(
    "/health",
    healthRoutes(undefined, {
      deploymentMode: opts.deploymentMode ?? "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    }),
  );
  return app;
}

const SNAPSHOT = {
  checked_at: "2026-08-03T22:33:47Z",
  overall: "UP",
  passing: 2,
  failing: 0,
  checks: [
    { name: "route:paperclip", status: "OK", detail: "responding 302", failing_minutes: 0 },
    { name: "svc:cloudflared", status: "OK", detail: "active", failing_minutes: 0 },
  ],
};

describe("GET /health/hub", () => {
  let dir: string;
  const originalPath = process.env.HUB_HEALTH_JSON_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-health-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.HUB_HEALTH_JSON_PATH;
    else process.env.HUB_HEALTH_JSON_PATH = originalPath;
  });

  it("returns 404 when no snapshot path is configured", async () => {
    delete process.env.HUB_HEALTH_JSON_PATH;
    const res = await request(createApp()).get("/health/hub");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "hub_health_not_configured" });
  });

  it("treats a whitespace-only path as unconfigured", async () => {
    process.env.HUB_HEALTH_JSON_PATH = "   ";
    const res = await request(createApp()).get("/health/hub");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "hub_health_not_configured" });
  });

  it("returns the snapshot when the file is readable", async () => {
    const file = join(dir, "hub-health.json");
    writeFileSync(file, JSON.stringify(SNAPSHOT), "utf8");
    process.env.HUB_HEALTH_JSON_PATH = file;

    const res = await request(createApp()).get("/health/hub");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SNAPSHOT);
  });

  it("returns 503 when the snapshot file is missing", async () => {
    process.env.HUB_HEALTH_JSON_PATH = join(dir, "does-not-exist.json");
    const res = await request(createApp()).get("/health/hub");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "hub_health_unavailable" });
  });

  // A monitor that writes a truncated or corrupt file must surface as an error. Returning
  // a partial payload would let the dashboard render a misleading all-clear.
  it("returns 503 when the snapshot is malformed JSON", async () => {
    const file = join(dir, "hub-health.json");
    writeFileSync(file, "{ not valid json", "utf8");
    process.env.HUB_HEALTH_JSON_PATH = file;

    const res = await request(createApp()).get("/health/hub");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "hub_health_unavailable" });
  });

  it("denies anonymous callers in authenticated mode", async () => {
    const file = join(dir, "hub-health.json");
    writeFileSync(file, JSON.stringify(SNAPSHOT), "utf8");
    process.env.HUB_HEALTH_JSON_PATH = file;

    const res = await request(
      createApp({ deploymentMode: "authenticated", actorType: "none" }),
    ).get("/health/hub");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "hub_health_auth_required" });
  });

  it("allows board actors in authenticated mode", async () => {
    const file = join(dir, "hub-health.json");
    writeFileSync(file, JSON.stringify(SNAPSHOT), "utf8");
    process.env.HUB_HEALTH_JSON_PATH = file;

    const res = await request(
      createApp({ deploymentMode: "authenticated", actorType: "board" }),
    ).get("/health/hub");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SNAPSHOT);
  });
});
