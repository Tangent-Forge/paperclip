import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecretVersions,
  companySecrets,
  createDb,
  pluginConfig,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPluginSecretsHandler } from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secrets handler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-secret-plugin",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Secret Plugin Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["secrets.read-ref"],
    entrypoints: { worker: "./dist/worker.js" },
    instanceConfigSchema: {
      type: "object",
      properties: {
        apiKeySecretRef: { type: "string", format: "secret-ref" },
        ignoredUuid: { type: "string" },
      },
    },
  };
}

describeEmbeddedPostgres("createPluginSecretsHandler", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-plugin-secrets-handler-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("plugin-secrets-handler");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginConfig);
    await db.delete(plugins);
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
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedPlugin(configJson: Record<string, unknown>) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.test-secret-plugin",
      packageName: "@paperclipai/test-secret-plugin",
      version: "0.1.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: manifest(),
      status: "ready",
      installedAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(pluginConfig).values({
      id: randomUUID(),
      pluginId,
      configJson,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return pluginId;
  }

  it("resolves a secret UUID referenced by the plugin config schema", async () => {
    const companyId = await seedCompany();
    const secret = await secretService(db).create(companyId, {
      name: `linear-token-${randomUUID()}`,
      provider: "local_encrypted",
      value: "linear-token-value",
    });
    const pluginId = await seedPlugin({
      apiKeySecretRef: secret.id,
      ignoredUuid: randomUUID(),
    });
    const handler = createPluginSecretsHandler({ db, pluginId });

    await expect(handler.resolve({ secretRef: secret.id })).resolves.toBe("linear-token-value");
  });

  it("rejects valid secret UUIDs that are not referenced by the plugin config schema", async () => {
    const companyId = await seedCompany();
    const allowedSecret = await secretService(db).create(companyId, {
      name: `allowed-${randomUUID()}`,
      provider: "local_encrypted",
      value: "allowed-value",
    });
    const unreferencedSecret = await secretService(db).create(companyId, {
      name: `unreferenced-${randomUUID()}`,
      provider: "local_encrypted",
      value: "unreferenced-value",
    });
    const pluginId = await seedPlugin({ apiKeySecretRef: allowedSecret.id });
    const handler = createPluginSecretsHandler({ db, pluginId });

    await expect(handler.resolve({ secretRef: unreferencedSecret.id })).rejects.toThrow(/secret not found/i);
  });

  it("still rejects malformed secret refs before database lookup", async () => {
    const pluginId = await seedPlugin({});
    const handler = createPluginSecretsHandler({ db, pluginId });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });
});
