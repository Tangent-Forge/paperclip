import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
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
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
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
