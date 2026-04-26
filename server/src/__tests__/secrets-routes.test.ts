import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/error-handler.js";

const mockSecretService = vi.hoisted(() => ({
  listProviders: vi.fn(),
  checkProviders: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    };
    next();
  });
  app.use("/api", secretRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("secret routes", () => {
  beforeEach(() => {
    mockSecretService.listProviders.mockReset();
    mockSecretService.checkProviders.mockReset();
    mockLogActivity.mockReset();
  });

  it("returns provider health checks for board callers with company access", async () => {
    mockSecretService.checkProviders.mockResolvedValue([
      {
        provider: "local_encrypted",
        status: "ok",
        message: "Local encrypted provider configured",
        backupGuidance: ["Back up the key file together with database backups."],
      },
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/secret-providers/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      providers: [
        {
          provider: "local_encrypted",
          status: "ok",
          message: "Local encrypted provider configured",
          backupGuidance: ["Back up the key file together with database backups."],
        },
      ],
    });
  });
});
