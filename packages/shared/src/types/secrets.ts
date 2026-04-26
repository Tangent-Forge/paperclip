import type {
  SecretAccessOutcome,
  SecretBindingTargetType,
  SecretManagedMode,
  SecretProvider,
  SecretStatus,
  SecretVersionStatus,
} from "../constants.js";

export type { SecretAccessOutcome, SecretBindingTargetType, SecretManagedMode, SecretProvider, SecretStatus, SecretVersionStatus };

export type SecretVersionSelector = number | "latest";

export interface EnvPlainBinding {
  type: "plain";
  value: string;
}

export interface EnvSecretRefBinding {
  type: "secret_ref";
  secretId: string;
  version?: SecretVersionSelector;
}

// Backward-compatible: legacy plaintext string values are still accepted.
export type EnvBinding = string | EnvPlainBinding | EnvSecretRefBinding;

export type AgentEnvConfig = Record<string, EnvBinding>;

export interface CompanySecret {
  id: string;
  companyId: string;
  key: string;
  name: string;
  provider: SecretProvider;
  status: SecretStatus;
  managedMode: SecretManagedMode;
  externalRef: string | null;
  providerConfigId: string | null;
  providerMetadata: Record<string, unknown> | null;
  latestVersion: number;
  description: string | null;
  lastResolvedAt: Date | null;
  lastRotatedAt: Date | null;
  deletedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretProviderDescriptor {
  id: SecretProvider;
  label: string;
  requiresExternalRef: boolean;
}

export interface CompanySecretVersion {
  id: string;
  secretId: string;
  version: number;
  providerVersionRef: string | null;
  status: SecretVersionStatus;
  fingerprintSha256: string;
  rotationJobId: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface CompanySecretBinding {
  id: string;
  companyId: string;
  secretId: string;
  targetType: SecretBindingTargetType;
  targetId: string;
  configPath: string;
  versionSelector: SecretVersionSelector;
  required: boolean;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretAccessEvent {
  id: string;
  companyId: string;
  secretId: string;
  version: number | null;
  provider: SecretProvider;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string | null;
  consumerType: SecretBindingTargetType;
  consumerId: string;
  configPath: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  pluginId: string | null;
  outcome: SecretAccessOutcome;
  errorCode: string | null;
  createdAt: Date;
}
