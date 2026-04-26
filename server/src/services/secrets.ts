import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  secretAccessEvents,
} from "@paperclipai/db";
import type {
  AgentEnvConfig,
  EnvBinding,
  SecretBindingTargetType,
  SecretProvider,
  SecretVersionSelector,
} from "@paperclipai/shared";
import { envBindingSchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  checkSecretProviders,
  getSecretProvider,
  listSecretProviders,
} from "../secrets/provider-registry.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const REDACTED_SENTINEL = "***REDACTED***";

type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version: number | "latest" };

type SecretConsumerContext = {
  consumerType: SecretBindingTargetType;
  consumerId: string;
  configPath?: string | null;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
  pluginId?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isSensitiveEnvKey(key: string) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

function normalizeSecretKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
  if (typeof binding === "string") {
    return { type: "plain", value: binding };
  }
  if (binding.type === "plain") {
    return { type: "plain", value: String(binding.value) };
  }
  return {
    type: "secret_ref",
    secretId: binding.secretId,
    version: binding.version ?? "latest",
  };
}

export function secretService(db: Db) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };

  async function getById(id: string) {
    return db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByName(companyId: string, name: string) {
    return db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, name)))
      .then((rows) => rows[0] ?? null);
  }

  async function getSecretVersion(secretId: string, version: number) {
    return db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, secretId),
          eq(companySecretVersions.version, version),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getBinding(input: {
    companyId: string;
    secretId: string;
    consumerType: SecretBindingTargetType;
    consumerId: string;
    configPath: string;
  }) {
    return db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, input.companyId),
          eq(companySecretBindings.secretId, input.secretId),
          eq(companySecretBindings.targetType, input.consumerType),
          eq(companySecretBindings.targetId, input.consumerId),
          eq(companySecretBindings.configPath, input.configPath),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function assertBindingContext(
    companyId: string,
    secretId: string,
    context: SecretConsumerContext | undefined,
  ) {
    if (!context) return;
    if (!context.configPath) {
      throw unprocessable("Secret resolution requires a binding config path");
    }
    const binding = await getBinding({
      companyId,
      secretId,
      consumerType: context.consumerType,
      consumerId: context.consumerId,
      configPath: context.configPath,
    });
    if (!binding) {
      throw unprocessable(
        `Secret is not bound to ${context.consumerType}:${context.consumerId} at ${context.configPath}`,
      );
    }
  }

  async function recordAccessEvent(input: {
    companyId: string;
    secretId: string;
    version: number | null;
    provider: SecretProvider;
    context: SecretConsumerContext | undefined;
    outcome: "success" | "failure";
    errorCode?: string | null;
  }) {
    if (!input.context) return;
    await db.insert(secretAccessEvents).values({
      companyId: input.companyId,
      secretId: input.secretId,
      version: input.version,
      provider: input.provider,
      actorType: input.context.actorType ?? "system",
      actorId: input.context.actorId ?? null,
      consumerType: input.context.consumerType,
      consumerId: input.context.consumerId,
      configPath: input.context.configPath ?? null,
      issueId: input.context.issueId ?? null,
      heartbeatRunId: input.context.heartbeatRunId ?? null,
      pluginId: input.context.pluginId ?? null,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
    });
  }

  async function assertSecretInCompany(companyId: string, secretId: string) {
    const secret = await getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    return secret;
  }

  async function resolveSecretValue(
    companyId: string,
    secretId: string,
    version: number | "latest",
    context?: SecretConsumerContext,
  ): Promise<string> {
    const secret = await assertSecretInCompany(companyId, secretId);
    const resolvedVersion = version === "latest" ? secret.latestVersion : version;
    const providerId = secret.provider as SecretProvider;
    try {
      if (secret.status !== "active") {
        throw unprocessable("Secret is not active");
      }
      await assertBindingContext(companyId, secret.id, context);
      const versionRow = await getSecretVersion(secret.id, resolvedVersion);
      if (!versionRow) throw notFound("Secret version not found");
      if (versionRow.status === "disabled" || versionRow.status === "destroyed" || versionRow.revokedAt) {
        throw unprocessable("Secret version is not active");
      }
      const provider = getSecretProvider(providerId);
      const value = await provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef,
        providerVersionRef: versionRow.providerVersionRef,
        context: {
          companyId,
          secretId: secret.id,
          secretKey: secret.key,
          version: resolvedVersion,
        },
      });
      await Promise.all([
        db
          .update(companySecrets)
          .set({ lastResolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(companySecrets.id, secret.id)),
        recordAccessEvent({
          companyId,
          secretId: secret.id,
          version: resolvedVersion,
          provider: providerId,
          context,
          outcome: "success",
        }),
      ]);
      return value;
    } catch (err) {
      await recordAccessEvent({
        companyId,
        secretId: secret.id,
        version: resolvedVersion,
        provider: providerId,
        context,
        outcome: "failure",
        errorCode: err instanceof Error ? err.message.slice(0, 120) : "resolution_failed",
      });
      throw err;
    }
  }

  async function normalizeEnvConfig(
    companyId: string,
    envValue: unknown,
    opts?: NormalizeEnvOptions,
  ): Promise<AgentEnvConfig> {
    const record = asRecord(envValue);
    if (!record) throw unprocessable(`${opts?.fieldPath ?? "env"} must be an object`);

    const normalized: AgentEnvConfig = {};
    for (const [key, rawBinding] of Object.entries(record)) {
      if (!ENV_KEY_RE.test(key)) {
        throw unprocessable(`Invalid environment variable name: ${key}`);
      }

      const parsed = envBindingSchema.safeParse(rawBinding);
      if (!parsed.success) {
        throw unprocessable(`Invalid environment binding for key: ${key}`);
      }

      const binding = canonicalizeBinding(parsed.data as EnvBinding);
      if (binding.type === "plain") {
        if (opts?.strictMode && isSensitiveEnvKey(key) && binding.value.trim().length > 0) {
          throw unprocessable(
            `Strict secret mode requires secret references for sensitive key: ${key}`,
          );
        }
        if (binding.value === REDACTED_SENTINEL) {
          throw unprocessable(`Refusing to persist redacted placeholder for key: ${key}`);
        }
        normalized[key] = binding;
        continue;
      }

      await assertSecretInCompany(companyId, binding.secretId);
      normalized[key] = {
        type: "secret_ref",
        secretId: binding.secretId,
        version: binding.version,
      };
    }
    return normalized;
  }

  async function normalizeAdapterConfigForPersistenceInternal(
    companyId: string,
    adapterConfig: Record<string, unknown>,
    opts?: { strictMode?: boolean },
  ) {
    const normalized = { ...adapterConfig };
    if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
      return normalized;
    }
    normalized.env = await normalizeEnvConfig(companyId, adapterConfig.env, opts);
    return normalized;
  }

  return {
    listProviders: () => listSecretProviders(),

    checkProviders: () => checkSecretProviders(),

    list: (companyId: string) =>
      db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, companyId))
        .orderBy(desc(companySecrets.createdAt)),

    listBindings: (companyId: string, secretId?: string) =>
      db
        .select()
        .from(companySecretBindings)
        .where(
          secretId
            ? and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.secretId, secretId))
            : eq(companySecretBindings.companyId, companyId),
        )
        .orderBy(desc(companySecretBindings.createdAt)),

    listAccessEvents: (companyId: string, secretId: string) =>
      db
        .select()
        .from(secretAccessEvents)
        .where(and(eq(secretAccessEvents.companyId, companyId), eq(secretAccessEvents.secretId, secretId)))
        .orderBy(desc(secretAccessEvents.createdAt)),

    getById,
    getByName,
    resolveSecretValue,

    create: async (
      companyId: string,
      input: {
        name: string;
        provider: SecretProvider;
        value?: string | null;
        key?: string | null;
        managedMode?: "paperclip_managed" | "external_reference";
        description?: string | null;
        externalRef?: string | null;
        providerVersionRef?: string | null;
        providerMetadata?: Record<string, unknown> | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const existing = await getByName(companyId, input.name);
      if (existing) throw conflict(`Secret already exists: ${input.name}`);
      const key = normalizeSecretKey(input.key ?? input.name);
      if (!key) throw unprocessable("Secret key is required");
      const duplicateKey = await db
        .select()
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, key)))
        .then((rows) => rows[0] ?? null);
      if (duplicateKey) throw conflict(`Secret key already exists: ${key}`);

      const managedMode = input.managedMode ?? "paperclip_managed";
      const provider = getSecretProvider(input.provider);
      if (managedMode === "external_reference" && !input.externalRef?.trim()) {
        throw unprocessable("External reference secrets require externalRef");
      }
      if (managedMode === "paperclip_managed" && input.externalRef?.trim()) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }
      if (managedMode === "paperclip_managed" && !input.value?.trim()) {
        throw unprocessable("Managed secrets require value");
      }
      const prepared =
        managedMode === "external_reference"
          ? await provider.linkExternalSecret({
              externalRef: input.externalRef ?? "",
              providerVersionRef: input.providerVersionRef ?? null,
              context: {
                companyId,
                secretKey: key,
                secretName: input.name,
                version: 1,
              },
            })
          : await provider.createSecret({
              value: input.value ?? "",
              externalRef: null,
              context: {
                companyId,
                secretKey: key,
                secretName: input.name,
                version: 1,
              },
            });

      return db.transaction(async (tx) => {
        const secret = await tx
          .insert(companySecrets)
          .values({
            companyId,
            key,
            name: input.name,
            provider: input.provider,
            status: "active",
            managedMode,
            externalRef: prepared.externalRef,
            providerMetadata: input.providerMetadata ?? null,
            latestVersion: 1,
            description: input.description ?? null,
            lastRotatedAt: new Date(),
            createdByAgentId: actor?.agentId ?? null,
            createdByUserId: actor?.userId ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx.insert(companySecretVersions).values({
          secretId: secret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          providerVersionRef: prepared.providerVersionRef ?? null,
          status: "current",
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        return secret;
      });
    },

    rotate: async (
      secretId: string,
      input: { value?: string | null; externalRef?: string | null; providerVersionRef?: string | null },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const nextVersion = secret.latestVersion + 1;
      if (secret.managedMode === "external_reference" && !(input.externalRef ?? secret.externalRef)?.trim()) {
        throw unprocessable("External reference secrets require externalRef");
      }
      if (secret.managedMode !== "external_reference" && input.externalRef?.trim()) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }
      if (secret.managedMode !== "external_reference" && !input.value?.trim()) {
        throw unprocessable("Managed secrets require value");
      }
      const prepared =
        secret.managedMode === "external_reference"
          ? await provider.linkExternalSecret({
              externalRef: input.externalRef ?? secret.externalRef ?? "",
              providerVersionRef: input.providerVersionRef ?? null,
              context: {
                companyId: secret.companyId,
                secretKey: secret.key,
                secretName: secret.name,
                version: nextVersion,
              },
            })
          : await provider.createVersion({
              value: input.value ?? "",
              externalRef: secret.externalRef ?? null,
              context: {
                companyId: secret.companyId,
                secretKey: secret.key,
                secretName: secret.name,
                version: nextVersion,
              },
            });

      return db.transaction(async (tx) => {
        await tx
          .update(companySecretVersions)
          .set({ status: "previous" })
          .where(eq(companySecretVersions.secretId, secret.id));
        await tx.insert(companySecretVersions).values({
          secretId: secret.id,
          version: nextVersion,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          providerVersionRef: prepared.providerVersionRef ?? null,
          status: "current",
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        const updated = await tx
          .update(companySecrets)
          .set({
            latestVersion: nextVersion,
            externalRef: prepared.externalRef,
            lastRotatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, secret.id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!updated) throw notFound("Secret not found");
        return updated;
      });
    },

    update: async (
      secretId: string,
      patch: {
        name?: string;
        key?: string;
        status?: "active" | "disabled" | "archived" | "deleted";
        description?: string | null;
        externalRef?: string | null;
        providerMetadata?: Record<string, unknown> | null;
      },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");

      if (patch.name && patch.name !== secret.name) {
        const duplicate = await getByName(secret.companyId, patch.name);
        if (duplicate && duplicate.id !== secret.id) {
          throw conflict(`Secret already exists: ${patch.name}`);
        }
      }
      const nextKey = patch.key ? normalizeSecretKey(patch.key) : secret.key;
      if (!nextKey) throw unprocessable("Secret key is required");
      if (nextKey !== secret.key) {
        const duplicateKey = await db
          .select()
          .from(companySecrets)
          .where(and(eq(companySecrets.companyId, secret.companyId), eq(companySecrets.key, nextKey)))
          .then((rows) => rows[0] ?? null);
        if (duplicateKey && duplicateKey.id !== secret.id) {
          throw conflict(`Secret key already exists: ${nextKey}`);
        }
      }
      const deleting = patch.status === "deleted";
      if (secret.managedMode !== "external_reference" && patch.externalRef !== undefined) {
        throw unprocessable("Managed secrets cannot override externalRef");
      }

      return db
        .update(companySecrets)
        .set({
          key: nextKey,
          name: patch.name ?? secret.name,
          status: patch.status ?? secret.status,
          description:
            patch.description === undefined ? secret.description : patch.description,
          externalRef:
            patch.externalRef === undefined ? secret.externalRef : patch.externalRef,
          providerMetadata:
            patch.providerMetadata === undefined ? secret.providerMetadata : patch.providerMetadata,
          deletedAt: deleting ? new Date() : secret.deletedAt,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    createBinding: async (input: {
      companyId: string;
      secretId: string;
      targetType: SecretBindingTargetType;
      targetId: string;
      configPath: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      label?: string | null;
    }) => {
      await assertSecretInCompany(input.companyId, input.secretId);
      const existing = await db
        .select()
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, input.companyId),
            eq(companySecretBindings.targetType, input.targetType),
            eq(companySecretBindings.targetId, input.targetId),
            eq(companySecretBindings.configPath, input.configPath),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict(`Secret binding already exists at ${input.configPath}`);
      return db
        .insert(companySecretBindings)
        .values({
          companyId: input.companyId,
          secretId: input.secretId,
          targetType: input.targetType,
          targetId: input.targetId,
          configPath: input.configPath,
          versionSelector: String(input.versionSelector ?? "latest"),
          required: input.required ?? true,
          label: input.label ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    syncEnvBindingsForTarget: async (
      companyId: string,
      target: { targetType: SecretBindingTargetType; targetId: string; pathPrefix?: string },
      envValue: unknown,
    ) => {
      const record = asRecord(envValue) ?? {};
      const refs: Array<{
        secretId: string;
        configPath: string;
        versionSelector: SecretVersionSelector;
      }> = [];
      const pathPrefix = target.pathPrefix ?? "env";
      for (const [key, rawBinding] of Object.entries(record)) {
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) continue;
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type !== "secret_ref") continue;
        await assertSecretInCompany(companyId, binding.secretId);
        refs.push({
          secretId: binding.secretId,
          configPath: `${pathPrefix}.${key}`,
          versionSelector: binding.version,
        });
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(companySecretBindings)
          .where(
            and(
              eq(companySecretBindings.companyId, companyId),
              eq(companySecretBindings.targetType, target.targetType),
              eq(companySecretBindings.targetId, target.targetId),
            ),
          );
        if (refs.length === 0) return;
        await tx.insert(companySecretBindings).values(
          refs.map((ref) => ({
            companyId,
            secretId: ref.secretId,
            targetType: target.targetType,
            targetId: target.targetId,
            configPath: ref.configPath,
            versionSelector: String(ref.versionSelector),
            required: true,
          })),
        );
      });
      return refs;
    },

    remove: async (secretId: string) => {
      const secret = await getById(secretId);
      if (!secret) return null;
      const versionRow = await getSecretVersion(secret.id, secret.latestVersion);
      const provider = getSecretProvider(secret.provider as SecretProvider);
      await provider.deleteOrArchive({
        material: versionRow?.material as Record<string, unknown> | undefined,
        externalRef: secret.externalRef,
        context: {
          companyId: secret.companyId,
          secretKey: secret.key,
          secretName: secret.name,
          version: secret.latestVersion,
        },
        mode: "delete",
      });
      await db.delete(companySecrets).where(eq(companySecrets.id, secretId));
      return secret;
    },

    normalizeAdapterConfigForPersistence: async (
      companyId: string,
      adapterConfig: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => normalizeAdapterConfigForPersistenceInternal(companyId, adapterConfig, opts),

    normalizeEnvBindingsForPersistence: async (
      companyId: string,
      envValue: unknown,
      opts?: NormalizeEnvOptions,
    ) => normalizeEnvConfig(companyId, envValue, opts),

    normalizeHireApprovalPayloadForPersistence: async (
      companyId: string,
      payload: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => {
      const normalized = { ...payload };
      const adapterConfig = asRecord(payload.adapterConfig);
      if (adapterConfig) {
        normalized.adapterConfig = await normalizeAdapterConfigForPersistenceInternal(
          companyId,
          adapterConfig,
          opts,
        );
      }
      return normalized;
    },

    resolveEnvBindings: async (
      companyId: string,
      envValue: unknown,
      context?: Omit<SecretConsumerContext, "configPath">,
    ): Promise<{ env: Record<string, string>; secretKeys: Set<string> }> => {
      const record = asRecord(envValue);
      if (!record) return { env: {} as Record<string, string>, secretKeys: new Set<string>() };
      const resolved: Record<string, string> = {};
      const secretKeys = new Set<string>();

      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          resolved[key] = binding.value;
        } else {
          resolved[key] = await resolveSecretValue(
            companyId,
            binding.secretId,
            binding.version,
            context ? { ...context, configPath: `env.${key}` } : undefined,
          );
          secretKeys.add(key);
        }
      }
      return { env: resolved, secretKeys };
    },

    resolveAdapterConfigForRuntime: async (
      companyId: string,
      adapterConfig: Record<string, unknown>,
      context?: Omit<SecretConsumerContext, "configPath">,
    ): Promise<{ config: Record<string, unknown>; secretKeys: Set<string> }> => {
      const resolved = { ...adapterConfig };
      const secretKeys = new Set<string>();
      if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
        return { config: resolved, secretKeys };
      }
      const record = asRecord(adapterConfig.env);
      if (!record) {
        resolved.env = {};
        return { config: resolved, secretKeys };
      }
      const env: Record<string, string> = {};
      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          env[key] = binding.value;
        } else {
          env[key] = await resolveSecretValue(
            companyId,
            binding.secretId,
            binding.version,
            context ? { ...context, configPath: `env.${key}` } : undefined,
          );
          secretKeys.add(key);
        }
      }
      resolved.env = env;
      return { config: resolved, secretKeys };
    },
  };
}
