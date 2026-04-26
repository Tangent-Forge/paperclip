import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
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

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("secrets-service");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
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
});
