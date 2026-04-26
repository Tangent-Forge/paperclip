import type { SecretProvider, SecretProviderDescriptor } from "@paperclipai/shared";
import type { DeploymentMode } from "@paperclipai/shared";

export interface StoredSecretVersionMaterial {
  [key: string]: unknown;
}

export type SecretProviderHealthStatus = "ok" | "warn" | "error";

export interface SecretProviderHealthCheck {
  provider: SecretProvider;
  status: SecretProviderHealthStatus;
  message: string;
  warnings?: string[];
  backupGuidance?: string[];
  details?: Record<string, unknown>;
}

export interface SecretProviderValidationResult {
  ok: boolean;
  warnings: string[];
}

export interface PreparedSecretVersion {
  material: StoredSecretVersionMaterial;
  valueSha256: string;
  fingerprintSha256?: string;
  externalRef: string | null;
  providerVersionRef?: string | null;
}

export interface SecretProviderRuntimeContext {
  companyId: string;
  secretId: string;
  secretKey: string;
  version: number;
}

export interface SecretProviderWriteContext {
  companyId: string;
  secretKey: string;
  secretName: string;
  version: number;
}

export interface SecretProviderModule {
  id: SecretProvider;
  descriptor(): SecretProviderDescriptor;
  validateConfig(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
  }): Promise<SecretProviderValidationResult>;
  createSecret(input: {
    value: string;
    externalRef?: string | null;
    context?: SecretProviderWriteContext;
  }): Promise<PreparedSecretVersion>;
  createVersion(input: {
    value: string;
    externalRef?: string | null;
    context?: SecretProviderWriteContext;
  }): Promise<PreparedSecretVersion>;
  linkExternalSecret(input: {
    externalRef: string;
    providerVersionRef?: string | null;
    context?: SecretProviderWriteContext;
  }): Promise<PreparedSecretVersion>;
  resolveVersion(input: {
    material: StoredSecretVersionMaterial;
    externalRef: string | null;
    providerVersionRef?: string | null;
    context?: SecretProviderRuntimeContext;
  }): Promise<string>;
  rotate?(input: {
    material: StoredSecretVersionMaterial;
    externalRef: string | null;
    providerVersionRef?: string | null;
  }): Promise<PreparedSecretVersion>;
  deleteOrArchive(input: {
    material?: StoredSecretVersionMaterial | null;
    externalRef: string | null;
    mode: "archive" | "delete";
  }): Promise<void>;
  healthCheck(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
  }): Promise<SecretProviderHealthCheck>;
}
