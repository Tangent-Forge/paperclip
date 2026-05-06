import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { awsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secrets service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secretService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-service-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secrets-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("rejects cross-company secret references during env normalization", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignSecret = await svc.create(companyB, {
      name: `foreign-${randomUUID()}`,
      provider: "local_encrypted",
      value: "secret-value",
    });

    await expect(
      svc.normalizeEnvBindingsForPersistence(companyA, {
        API_KEY: { type: "secret_ref", secretId: foreignSecret.id, version: "latest" },
      }),
    ).rejects.toThrow(/same company/i);
  });

  it("prevents duplicate bindings for a target config path", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const firstSecret = await svc.create(companyId, {
      name: `first-${randomUUID()}`,
      provider: "local_encrypted",
      value: "one",
    });
    const secondSecret = await svc.create(companyId, {
      name: `second-${randomUUID()}`,
      provider: "local_encrypted",
      value: "two",
    });

    await svc.createBinding({
      companyId,
      secretId: firstSecret.id,
      targetType: "agent",
      targetId: "agent-1",
      configPath: "env.API_KEY",
    });

    await expect(
      svc.createBinding({
        companyId,
        secretId: secondSecret.id,
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.API_KEY",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("reports reference counts and resolves binding target labels", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `referenced-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "CodexCoder",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
      })
      .returning();

    await svc.syncEnvBindingsForTarget(
      companyId,
      { targetType: "agent", targetId: agent!.id },
      {
        OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
      },
    );

    const listed = await svc.list(companyId);
    expect(listed.find((row) => row.id === secret.id)?.referenceCount).toBe(1);

    const bindings = await svc.listBindingReferences(companyId, secret.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.target).toMatchObject({
      type: "agent",
      id: agent!.id,
      label: "CodexCoder",
      href: "/agents/codexcoder",
      status: "idle",
    });
  });

  it("enforces binding context and records value-free access events", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `runtime-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-2",
        actorType: "agent",
        actorId: "agent-2",
      }),
    ).rejects.toThrow(/not bound/i);

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    expect(resolved.env.API_KEY).toBe("runtime-secret");
    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.outcome).sort()).toEqual(["failure", "success"]);
    expect(JSON.stringify(events)).not.toContain("runtime-secret");
  });

  it("stores external references without requiring or persisting secret values", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);

    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/test",
      providerVersionRef: "version-1",
    });

    expect(secret.managedMode).toBe("external_reference");
    expect(secret.externalRef).toBe("arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/test");

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.providerVersionRef).toBe("version-1");
    expect(JSON.stringify(versions[0])).not.toContain("runtime-secret");
    expect(JSON.stringify(versions[0])).not.toContain("sk-");

    await expect(
      svc.resolveSecretValue(companyId, secret.id, "latest", {
        consumerType: "system",
        consumerId: "system",
        configPath: "env.EXTERNAL_SECRET",
      }),
    ).rejects.toThrow(/not bound/i);
  });

  it("keeps one default provider vault per company provider", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);

    const first = await svc.createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Local primary",
      isDefault: true,
      config: {},
    });
    const second = await svc.createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Local secondary",
      isDefault: true,
      config: {},
    });

    const rows = await svc.listProviderConfigs(companyId);
    expect(rows.find((row) => row.id === first.id)?.isDefault).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.isDefault).toBe(true);
  });

  it("rejects provider vaults from another company when creating a secret", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignVault = await svc.createProviderConfig(companyB, {
      provider: "local_encrypted",
      displayName: "Foreign vault",
      config: {},
    });

    await expect(
      svc.create(companyA, {
        name: `managed-${randomUUID()}`,
        provider: "local_encrypted",
        providerConfigId: foreignVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow(/same company/i);
  });

  it("blocks coming-soon provider vaults from secret selection", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const draftVault = await svc.createProviderConfig(companyId, {
      provider: "gcp_secret_manager",
      displayName: "GCP draft",
      config: { projectId: "paperclip-prod1" },
    });

    expect(draftVault.status).toBe("coming_soon");
    await expect(
      svc.create(companyId, {
        name: `draft-${randomUUID()}`,
        provider: "gcp_secret_manager",
        providerConfigId: draftVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow(/coming soon/i);
  });

  it("passes selected provider vault config through create, rotate, and resolve", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: {
        region: "us-east-1",
        namespace: "prod-use1",
        secretNamePrefix: "paperclip",
      },
    });

    const createSpy = vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
      providerVersionRef: "aws-version-1",
    });
    const createVersionSpy = vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
      providerVersionRef: "aws-version-2",
    });
    const resolveSpy = vi.spyOn(awsSecretsManagerProvider, "resolveVersion").mockResolvedValue("resolved-secret");

    const secret = await svc.create(companyId, {
      name: `aws-managed-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });
    const rotated = await svc.rotate(secret.id, { value: "rotated-runtime-secret" });
    const resolved = await svc.resolveSecretValue(companyId, rotated.id, "latest");

    expect(resolved).toBe("resolved-secret");
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({
        id: awsVault.id,
        provider: "aws_secrets_manager",
        config: expect.objectContaining({ region: "us-east-1", namespace: "prod-use1" }),
      }),
    }));
    expect(createVersionSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
    }));
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      providerVersionRef: "aws-version-2",
    }));
    expect(JSON.stringify(resolveSpy.mock.calls[0]?.[0])).not.toContain("resolved-secret");
  });

  it("previews AWS remote import candidates with duplicate and collision enrichment", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const duplicate = await svc.create(companyId, {
      name: "Existing duplicate",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/duplicate",
    });
    const nameConflict = await svc.create(companyId, {
      name: "Prod Conflict",
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    const listSpy = vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      nextToken: "next-page",
      secrets: [
        {
          externalRef: duplicate.externalRef!,
          name: "prod/duplicate",
          providerVersionRef: null,
          metadata: { arn: duplicate.externalRef },
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/conflict",
          name: nameConflict.name,
          providerVersionRef: null,
          metadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/conflict" },
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/ready",
          name: "prod/ready",
          providerVersionRef: null,
          metadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/ready" },
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
      query: "prod",
      pageSize: 25,
    });

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      query: "prod",
      pageSize: 25,
    }));
    expect(preview.nextToken).toBe("next-page");
    expect(preview.candidates.map((candidate) => candidate.status)).toEqual([
      "duplicate",
      "conflict",
      "ready",
    ]);
    expect(preview.candidates[0]?.conflicts[0]).toMatchObject({
      type: "exact_reference",
      existingSecretId: duplicate.id,
    });
    expect(preview.candidates[1]?.conflicts[0]).toMatchObject({
      type: "name",
      existingSecretId: nameConflict.id,
    });
    expect(preview.candidates[2]).toMatchObject({
      importable: true,
      name: "prod/ready",
      key: "prod-ready",
    });
  });

  it("imports AWS remote references row-by-row without fetching plaintext", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const duplicate = await svc.create(companyId, {
      name: "Existing duplicate",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/duplicate",
    });

    const resolveSpy = vi.spyOn(awsSecretsManagerProvider, "resolveVersion");
    const result = await svc.importRemoteSecrets(
      companyId,
      {
        providerConfigId: awsVault.id,
        secrets: [
          {
            externalRef: duplicate.externalRef!,
            name: "Existing duplicate",
            key: "existing-duplicate",
          },
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "openai-api-key",
            providerMetadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai" },
          },
        ],
      },
      { userId: "user-1" },
    );

    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.results.map((row) => row.status)).toEqual(["skipped", "imported"]);
    expect(result.results[0]).toMatchObject({
      reason: "exact_reference_duplicate",
      conflicts: [expect.objectContaining({ type: "exact_reference", existingSecretId: duplicate.id })],
    });
    expect(resolveSpy).not.toHaveBeenCalled();

    const imported = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.key, "openai-api-key"))
      .then((rows) => rows[0]);
    expect(imported).toMatchObject({
      companyId,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
      createdByUserId: "user-1",
    });

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, imported!.id));
    expect(versions).toHaveLength(1);
    expect(JSON.stringify(versions[0])).not.toContain("runtime-secret");
    expect(JSON.stringify(versions[0])).not.toContain("sk-");
  });

  it("rejects remote import for disabled or cross-company provider vaults", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const disabledVault = await svc.createProviderConfig(companyA, {
      provider: "aws_secrets_manager",
      displayName: "AWS disabled",
      status: "disabled",
      config: { region: "us-east-1" },
    });
    const foreignVault = await svc.createProviderConfig(companyB, {
      provider: "aws_secrets_manager",
      displayName: "AWS foreign",
      config: { region: "us-east-1" },
    });

    await expect(
      svc.previewRemoteImport(companyA, { providerConfigId: disabledVault.id }),
    ).rejects.toThrow(/disabled/i);
    await expect(
      svc.previewRemoteImport(companyA, { providerConfigId: foreignVault.id }),
    ).rejects.toThrow(/same company/i);
  });

  it("rejects externalRef overrides on managed secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `managed-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await expect(
      svc.update(secret.id, {
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-b/openai-api-key",
      }),
    ).rejects.toThrow(/Managed secrets cannot override externalRef/i);

    await expect(
      svc.rotate(secret.id, {
        value: "rotated-runtime-secret",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-b/openai-api-key",
      }),
    ).rejects.toThrow(/Managed secrets cannot override externalRef/i);
  });

  it("passes managed AWS secret context into provider delete during removal", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key";

    const secret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: "openai-api-key",
        name: "OpenAI API Key",
        provider: "aws_secrets_manager",
        managedMode: "paperclip_managed",
        externalRef,
        latestVersion: 1,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]);

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });

    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();

    const removed = await svc.remove(secret.id);
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0] ?? null);

    expect(removed?.id).toBe(secret.id);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      externalRef,
      context: {
        companyId,
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
      mode: "delete",
      providerConfig: null,
    });
    expect(persisted).toBeNull();
  });

  it("refuses to resolve secrets once they are disabled or archived", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `managed-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await svc.update(secret.id, { status: "disabled" });
    await expect(svc.resolveSecretValue(companyId, secret.id, "latest")).rejects.toThrow(
      /not active/i,
    );

    await svc.update(secret.id, { status: "archived" });
    await expect(svc.resolveSecretValue(companyId, secret.id, "latest")).rejects.toThrow(
      /not active/i,
    );
  });
});
