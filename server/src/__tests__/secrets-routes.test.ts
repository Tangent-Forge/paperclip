import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/error-handler.js";

const mockSecretService = vi.hoisted(() => ({
  listProviders: vi.fn(),
  checkProviders: vi.fn(),
  listProviderConfigs: vi.fn(),
  getProviderConfigById: vi.fn(),
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  disableProviderConfig: vi.fn(),
  setDefaultProviderConfig: vi.fn(),
  checkProviderConfigHealth: vi.fn(),
  create: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  source: "session",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", secretRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("secret routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockSecretService)) {
      mock.mockReset();
    }
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

  it("rejects managed secret creation when externalRef is supplied", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secrets").send({
      name: "OpenAI API Key",
      managedMode: "paperclip_managed",
      value: "secret-value",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Managed secrets cannot set externalRef/);
    expect(mockSecretService.create).not.toHaveBeenCalled();
  });

  it("rejects provider vault routes for non-board actors", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    })).get("/api/companies/company-1/secret-provider-configs");

    expect(res.status).toBe(403);
    expect(mockSecretService.listProviderConfigs).not.toHaveBeenCalled();
  });

  it("rejects provider vault cross-company access before calling the service", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-2"],
      memberships: [{ companyId: "company-2", status: "active", membershipRole: "admin" }],
    })).get("/api/companies/company-1/secret-provider-configs");

    expect(res.status).toBe(403);
    expect(mockSecretService.listProviderConfigs).not.toHaveBeenCalled();
  });

  it("rejects sensitive provider vault config fields", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      config: {
        region: "us-east-1",
        accessKeyId: "AKIA...",
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/sensitive field/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects ready status for coming-soon provider vaults", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "vault",
      displayName: "Vault draft",
      status: "ready",
      config: {
        address: "https://vault.example.com",
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/locked while coming soon/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing Vault provider vault addresses before persistence", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "vault",
      displayName: "Vault draft",
      config: {
        address: "https://user:pass@vault.example.com",
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it.each([
    "https://vault.example.com?token=hvs.x",
    "https://vault.example.com#token=hvs.x",
  ])("rejects token-bearing Vault provider vault address %s before persistence", async (address) => {
    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "vault",
      displayName: "Vault draft",
      config: { address },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects unsafe Vault provider vault address patches before persistence", async () => {
    const res = await request(createApp()).patch("/api/secret-provider-configs/vault-1").send({
      config: {
        address: "https://vault.example.com#token=hvs.x",
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
    expect(mockSecretService.getProviderConfigById).not.toHaveBeenCalled();
    expect(mockSecretService.updateProviderConfig).not.toHaveBeenCalled();
  });

  it("creates provider vaults and logs safe activity details", async () => {
    const createdAt = new Date("2026-05-06T00:00:00.000Z");
    mockSecretService.createProviderConfig.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      status: "ready",
      isDefault: true,
      config: { region: "us-east-1" },
      healthStatus: null,
      healthCheckedAt: null,
      healthMessage: null,
      healthDetails: null,
      disabledAt: null,
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt,
      updatedAt: createdAt,
    });

    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      isDefault: true,
      config: { region: "us-east-1" },
    });

    expect(res.status).toBe(201);
    expect(mockSecretService.createProviderConfig).toHaveBeenCalledWith(
      "company-1",
      {
        provider: "aws_secrets_manager",
        displayName: "AWS prod",
        status: undefined,
        isDefault: true,
        config: { region: "us-east-1" },
      },
      { userId: "user-1", agentId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "secret_provider_config.created",
      details: {
        provider: "aws_secrets_manager",
        displayName: "AWS prod",
        status: "ready",
        isDefault: true,
      },
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("accessKey");
  });
});
