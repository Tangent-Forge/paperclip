import { createHash } from "node:crypto";
import { defaultProvider as defaultAwsCredentialsProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { DeploymentMode } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type {
  PreparedSecretVersion,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderWriteContext,
  StoredSecretVersionMaterial,
} from "./types.js";

const AWS_SECRETS_MANAGER_SCHEME = "aws_secrets_manager_v1";
const DEFAULT_PREFIX = "paperclip";
const DEFAULT_OWNER_TAG = "paperclip";
const DEFAULT_VERSION_STAGE = "AWSCURRENT";
const DEFAULT_DELETE_RECOVERY_WINDOW_DAYS = 30;

interface AwsSecretsManagerMaterial extends StoredSecretVersionMaterial {
  scheme: typeof AWS_SECRETS_MANAGER_SCHEME;
  secretId: string;
  versionId: string | null;
  source: "managed" | "external_reference";
}

interface AwsSecretsManagerConfig {
  region: string;
  endpoint: string;
  deploymentId: string;
  prefix: string;
  kmsKeyId: string;
  environmentTag: string;
  providerOwnerTag: string;
  deleteRecoveryWindowDays: number;
}

interface AwsSecretsManagerTag {
  Key: string;
  Value: string;
}

type ManagedSecretNamespaceContext = Pick<SecretProviderWriteContext, "companyId" | "secretKey">;

interface AwsSecretsManagerGateway {
  createSecret(input: {
    Name: string;
    SecretString: string;
    KmsKeyId: string;
    Description?: string;
    Tags: AwsSecretsManagerTag[];
  }): Promise<{
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  putSecretValue(input: {
    SecretId: string;
    SecretString: string;
  }): Promise<{
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  getSecretValue(input: {
    SecretId: string;
    VersionId?: string;
    VersionStage?: string;
  }): Promise<{
    SecretString?: string;
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  deleteSecret(input: {
    SecretId: string;
    RecoveryWindowInDays: number;
  }): Promise<unknown>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuredAwsSecretsManagerDescriptor() {
  return {
    id: "aws_secrets_manager" as const,
    label: "AWS Secrets Manager",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: true,
    configured: canLoadAwsSecretsManagerConfig(),
  };
}

function canLoadAwsSecretsManagerConfig() {
  return Boolean(
    (
      process.env.PAPERCLIP_SECRETS_AWS_REGION ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION
    )?.trim() &&
      process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID?.trim() &&
      process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID?.trim(),
  );
}

function loadAwsSecretsManagerConfig(): AwsSecretsManagerConfig {
  const region =
    process.env.PAPERCLIP_SECRETS_AWS_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim();
  const deploymentId = process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID?.trim();
  const kmsKeyId = process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID?.trim();

  if (!region) {
    throw unprocessable(
      "AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION",
    );
  }
  if (!deploymentId) {
    throw unprocessable(
      "AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID",
    );
  }
  if (!kmsKeyId) {
    throw unprocessable(
      "AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_KMS_KEY_ID",
    );
  }

  const recoveryWindowRaw = process.env.PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS?.trim();
  const recoveryWindow = recoveryWindowRaw ? Number(recoveryWindowRaw) : DEFAULT_DELETE_RECOVERY_WINDOW_DAYS;
  if (!Number.isFinite(recoveryWindow) || recoveryWindow < 7 || recoveryWindow > 30) {
    throw unprocessable(
      "PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS must be an integer between 7 and 30",
    );
  }

  return {
    region,
    endpoint:
      process.env.PAPERCLIP_SECRETS_AWS_ENDPOINT?.trim() ||
      `https://secretsmanager.${region}.amazonaws.com`,
    deploymentId,
    prefix: sanitizePathSegment(process.env.PAPERCLIP_SECRETS_AWS_PREFIX?.trim() || DEFAULT_PREFIX),
    kmsKeyId,
    environmentTag:
      process.env.PAPERCLIP_SECRETS_AWS_ENVIRONMENT?.trim() ||
      process.env.NODE_ENV?.trim() ||
      "unknown",
    providerOwnerTag:
      process.env.PAPERCLIP_SECRETS_AWS_PROVIDER_OWNER?.trim() || DEFAULT_OWNER_TAG,
    deleteRecoveryWindowDays: recoveryWindow,
  };
}

function sanitizePathSegment(input: string) {
  return input
    .trim()
    .replace(/[^A-Za-z0-9/_+=.@-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function buildManagedSecretName(
  config: AwsSecretsManagerConfig,
  context: ManagedSecretNamespaceContext | undefined,
) {
  if (!context) {
    throw unprocessable("AWS Secrets Manager provider requires secret context for managed values");
  }
  return [
    sanitizePathSegment(config.prefix),
    sanitizePathSegment(config.deploymentId),
    sanitizePathSegment(context.companyId),
    sanitizePathSegment(context.secretKey),
  ]
    .filter(Boolean)
    .join("/");
}

function buildManagedSecretId(
  config: AwsSecretsManagerConfig,
  context: ManagedSecretNamespaceContext | undefined,
) {
  return buildManagedSecretName(config, context);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAwsSecretName(externalRef: string) {
  const trimmed = externalRef.trim();
  const arnMatch = /^arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:(.+)$/i.exec(trimmed);
  return arnMatch?.[1] ?? trimmed;
}

function isManagedSecretRefForContext(
  config: AwsSecretsManagerConfig,
  context: ManagedSecretNamespaceContext | undefined,
  externalRef: string | null | undefined,
) {
  if (!externalRef?.trim()) return false;
  const expectedName = buildManagedSecretName(config, context);
  const actualName = extractAwsSecretName(externalRef);
  return new RegExp(`^${escapeRegExp(expectedName)}(?:-[A-Za-z0-9]{6})?$`).test(actualName);
}

function resolveManagedSecretRef(input: {
  config: AwsSecretsManagerConfig;
  context: ManagedSecretNamespaceContext | undefined;
  externalRefs: Array<string | null | undefined>;
}) {
  for (const externalRef of input.externalRefs) {
    if (externalRef?.trim() && isManagedSecretRefForContext(input.config, input.context, externalRef)) {
      return externalRef.trim();
    }
  }
  return buildManagedSecretId(input.config, input.context);
}

function buildManagedSecretTags(
  config: AwsSecretsManagerConfig,
  context: SecretProviderWriteContext | undefined,
): AwsSecretsManagerTag[] {
  if (!context) return [];
  return [
    { Key: "paperclip:managed-by", Value: "paperclip" },
    { Key: "paperclip:provider-owner", Value: config.providerOwnerTag },
    { Key: "paperclip:deployment-id", Value: config.deploymentId },
    { Key: "paperclip:company-id", Value: context.companyId },
    { Key: "paperclip:secret-key", Value: context.secretKey },
    { Key: "paperclip:environment", Value: config.environmentTag },
  ];
}

function createExternalReferenceMaterial(
  externalRef: string,
  providerVersionRef: string | null,
): PreparedSecretVersion {
  const normalizedExternalRef = externalRef.trim();
  const normalizedProviderVersionRef = providerVersionRef?.trim() || null;
  const fingerprint = sha256Hex(
    `${AWS_SECRETS_MANAGER_SCHEME}:${normalizedExternalRef}:${normalizedProviderVersionRef ?? ""}`,
  );
  return {
    material: {
      scheme: AWS_SECRETS_MANAGER_SCHEME,
      secretId: normalizedExternalRef,
      versionId: normalizedProviderVersionRef,
      source: "external_reference",
    },
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef: normalizedExternalRef,
    providerVersionRef: normalizedProviderVersionRef,
  };
}

function createManagedMaterial(secretId: string, versionId: string | null): AwsSecretsManagerMaterial {
  return {
    scheme: AWS_SECRETS_MANAGER_SCHEME,
    secretId,
    versionId,
    source: "managed",
  };
}

function asAwsSecretsManagerMaterial(value: StoredSecretVersionMaterial): AwsSecretsManagerMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === AWS_SECRETS_MANAGER_SCHEME &&
    typeof value.secretId === "string" &&
    (typeof value.versionId === "string" || value.versionId === null) &&
    (value.source === "managed" || value.source === "external_reference")
  ) {
    return value as AwsSecretsManagerMaterial;
  }
  throw unprocessable("Invalid AWS Secrets Manager material");
}

function normalizeAwsError(operation: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/ResourceExistsException/i.test(message)) {
    throw conflict(`AWS Secrets Manager ${operation} conflict: ${message}`);
  }
  if (/ResourceNotFoundException/i.test(message)) {
    throw notFound(`AWS Secrets Manager ${operation} failed: ${message}`);
  }
  throw unprocessable(`AWS Secrets Manager ${operation} failed: ${message}`);
}

class AwsSecretsManagerJsonGateway implements AwsSecretsManagerGateway {
  private readonly endpoint: URL;
  private readonly signer: SignatureV4;

  constructor(private readonly config: AwsSecretsManagerConfig) {
    this.endpoint = new URL(config.endpoint);
    this.signer = new SignatureV4({
      credentials: defaultAwsCredentialsProvider(),
      region: config.region,
      service: "secretsmanager",
      sha256: Hash.bind(null, "sha256"),
    });
  }

  createSecret(input: {
    Name: string;
    SecretString: string;
    KmsKeyId: string;
    Description?: string;
    Tags: AwsSecretsManagerTag[];
  }) {
    return this.call<{
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("CreateSecret", input);
  }

  putSecretValue(input: {
    SecretId: string;
    SecretString: string;
  }) {
    return this.call<{
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("PutSecretValue", input);
  }

  getSecretValue(input: {
    SecretId: string;
    VersionId?: string;
    VersionStage?: string;
  }) {
    return this.call<{
      SecretString?: string;
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("GetSecretValue", input);
  }

  deleteSecret(input: {
    SecretId: string;
    RecoveryWindowInDays: number;
  }) {
    return this.call("DeleteSecret", input);
  }

  private async call<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload);
    const request = new HttpRequest({
      protocol: this.endpoint.protocol,
      hostname: this.endpoint.hostname,
      port: this.endpoint.port ? Number(this.endpoint.port) : undefined,
      method: "POST",
      path: this.endpoint.pathname || "/",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        host: this.endpoint.host,
        "x-amz-target": `secretsmanager.${operation}`,
      },
      body,
    });
    const signed = await this.signer.sign(request);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: signed.headers as Record<string, string>,
      body,
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const code = String(parsed.__type ?? parsed.code ?? parsed.Code ?? response.statusText ?? "UnknownError");
      const message = String(parsed.message ?? parsed.Message ?? code);
      throw new Error(`${code}: ${message}`);
    }

    return parsed as T;
  }
}

export function createAwsSecretsManagerProvider(
  options?: {
    config?: AwsSecretsManagerConfig;
    gateway?: AwsSecretsManagerGateway;
  },
): SecretProviderModule {
  function resolveConfig() {
    return options?.config ?? loadAwsSecretsManagerConfig();
  }

  function resolveGateway(config: AwsSecretsManagerConfig) {
    return options?.gateway ?? new AwsSecretsManagerJsonGateway(config);
  }

  async function validateConfig(
    input?: { deploymentMode?: DeploymentMode; strictMode?: boolean },
  ): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.deploymentMode === "authenticated" && input.strictMode !== true) {
      warnings.push("Strict secret mode should be enabled for authenticated deployments");
    }
    const config = resolveConfig();
    if (!config.prefix) {
      warnings.push("PAPERCLIP_SECRETS_AWS_PREFIX should be set to a deployment-scoped prefix");
    }
    return { ok: true, warnings };
  }

  async function healthCheck(
    input?: { deploymentMode?: DeploymentMode; strictMode?: boolean },
  ): Promise<SecretProviderHealthCheck> {
    try {
      const validation = await validateConfig(input);
      return {
        provider: "aws_secrets_manager",
        status: validation.warnings.length > 0 ? "warn" : "ok",
        message: "AWS Secrets Manager provider is configured",
        warnings: validation.warnings,
        details: {
          region: resolveConfig().region,
          prefix: resolveConfig().prefix,
          deploymentId: resolveConfig().deploymentId,
          kmsKeyConfigured: true,
        },
        backupGuidance: [
          "Back up Paperclip metadata separately from AWS-managed secrets.",
          "Restoring access requires the Paperclip database plus the same AWS secret namespace and KMS permissions.",
        ],
      };
    } catch (error) {
      return {
        provider: "aws_secrets_manager",
        status: "warn",
        message: error instanceof Error ? error.message : String(error),
        warnings: [
          "Managed secret create/rotate/resolve calls will fail until AWS provider configuration is complete.",
        ],
      };
    }
  }

  return {
    id: "aws_secrets_manager",
    descriptor() {
      return configuredAwsSecretsManagerDescriptor();
    },
    validateConfig,
    async createSecret(input) {
      const config = resolveConfig();
      const gateway = resolveGateway(config);
      const valueSha256 = sha256Hex(input.value);
      const secretId = buildManagedSecretId(config, input.context);

      try {
        const created = await gateway.createSecret({
          Name: secretId,
          SecretString: input.value,
          KmsKeyId: config.kmsKeyId,
          Description: input.context ? `Paperclip secret ${input.context.secretName}` : undefined,
          Tags: buildManagedSecretTags(config, input.context),
        });
        const normalizedSecretId = created.ARN ?? created.Name ?? secretId;
        return {
          material: createManagedMaterial(normalizedSecretId, created.VersionId ?? null),
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: normalizedSecretId,
          providerVersionRef: created.VersionId ?? null,
        };
      } catch (error) {
        normalizeAwsError("createSecret", error);
      }
    },
    async createVersion(input) {
      const config = resolveConfig();
      const gateway = resolveGateway(config);
      const valueSha256 = sha256Hex(input.value);
      const secretId = resolveManagedSecretRef({
        config,
        context: input.context,
        externalRefs: [input.externalRef],
      });

      try {
        const created = await gateway.putSecretValue({
          SecretId: secretId,
          SecretString: input.value,
        });
        const normalizedSecretId = created.ARN ?? created.Name ?? secretId;
        return {
          material: createManagedMaterial(normalizedSecretId, created.VersionId ?? null),
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: normalizedSecretId,
          providerVersionRef: created.VersionId ?? null,
        };
      } catch (error) {
        normalizeAwsError("createVersion", error);
      }
    },
    async linkExternalSecret(input) {
      return createExternalReferenceMaterial(input.externalRef, input.providerVersionRef ?? null);
    },
    async resolveVersion(input) {
      const config = resolveConfig();
      const gateway = resolveGateway(config);
      const material = asAwsSecretsManagerMaterial(input.material);
      const secretId =
        material.source === "managed"
          ? resolveManagedSecretRef({
              config,
              context: input.context,
              externalRefs: [input.externalRef, material.secretId],
            })
          : (input.externalRef ?? material.secretId);

      try {
        const resolved = await gateway.getSecretValue({
          SecretId: secretId,
          VersionId: input.providerVersionRef ?? material.versionId ?? undefined,
          VersionStage:
            input.providerVersionRef || material.versionId ? undefined : DEFAULT_VERSION_STAGE,
        });
        if (typeof resolved.SecretString !== "string") {
          throw new Error("SecretString was empty");
        }
        return resolved.SecretString;
      } catch (error) {
        normalizeAwsError("resolveVersion", error);
      }
    },
    async deleteOrArchive(input) {
      const material =
        input.material && typeof input.material === "object"
          ? asAwsSecretsManagerMaterial(input.material)
          : null;

      if (input.mode !== "delete" || material?.source !== "managed") return;

      const config = resolveConfig();
      const gateway = resolveGateway(config);
      const secretId = resolveManagedSecretRef({
        config,
        context: input.context,
        externalRefs: [input.externalRef, material.secretId],
      });

      try {
        await gateway.deleteSecret({
          SecretId: secretId,
          RecoveryWindowInDays: config.deleteRecoveryWindowDays,
        });
      } catch (error) {
        normalizeAwsError("deleteSecret", error);
      }
    },
    healthCheck,
  };
}

export const awsSecretsManagerProvider = createAwsSecretsManagerProvider();
