import { afterEach, describe, expect, it } from "vitest";
import { createAwsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";

describe("awsSecretsManagerProvider", () => {
  const previousEnv = {
    PAPERCLIP_SECRETS_AWS_REGION: process.env.PAPERCLIP_SECRETS_AWS_REGION,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID: process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID,
    PAPERCLIP_SECRETS_AWS_KMS_KEY_ID: process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("creates Paperclip-managed AWS secrets without persisting plaintext in provider material", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret(input) {
          calls.push({ op: "createSecret", input });
          return {
            ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
            VersionId: "aws-version-1",
          };
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return { ARN: String(input.SecretId), VersionId: "unused" };
        },
        async getSecretValue(input) {
          calls.push({ op: "getSecretValue", input });
          return { SecretString: "resolved-value", VersionId: "unused" };
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
      },
    });

    const prepared = await provider.createSecret({
      value: "super-secret-value",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        op: "createSecret",
        input: expect.objectContaining({
          Name: "paperclip/prod-use1/company-1/openai-api-key",
          KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        }),
      }),
    ]);
    expect(JSON.stringify(prepared)).not.toContain("super-secret-value");
    expect(prepared.externalRef).toContain("paperclip/prod-use1/company-1/openai-api-key");
    expect(prepared.providerVersionRef).toBe("aws-version-1");
  });

  it("creates new AWS secret versions against a namespace-valid existing secret reference", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return {
            ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
            VersionId: "aws-version-2",
          };
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    const prepared = await provider.createVersion({
      value: "rotated-secret-value",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });

    expect(calls).toEqual([
      {
        op: "putSecretValue",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          SecretString: "rotated-secret-value",
        },
      },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("rotated-secret-value");
    expect(prepared.providerVersionRef).toBe("aws-version-2");
  });

  it("rejects out-of-namespace refs for managed AWS secret version writes", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return { Name: String(input.SecretId), VersionId: "aws-version-2" };
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      provider.createVersion({
        value: "rotated-secret-value",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);

    expect(calls).toEqual([]);
  });

  it("stores linked external references as metadata-only provider material", async () => {
    const provider = createAwsSecretsManagerProvider();

    const prepared = await provider.linkExternalSecret({
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
      providerVersionRef: "linked-version-7",
    });

    expect(prepared.externalRef).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
    );
    expect(prepared.providerVersionRef).toBe("linked-version-7");
    expect(prepared.valueSha256).toBeTruthy();
  });

  it("resolves AWS secret values by provider version reference", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue(input) {
          calls.push({ op: "getSecretValue", input });
          return { SecretString: "resolved-secret-value", VersionId: "aws-version-2" };
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
        versionId: "aws-version-2",
        source: "managed",
      },
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      providerVersionRef: "aws-version-2",
      context: {
        companyId: "company-1",
        secretId: "secret-1",
        secretKey: "openai-api-key",
        version: 2,
      },
    });

    expect(resolved).toBe("resolved-secret-value");
    expect(calls).toEqual([
      {
        op: "getSecretValue",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          VersionId: "aws-version-2",
          VersionStage: undefined,
        },
      },
    ]);
  });

  it("rejects managed resolve attempts when stored refs drift outside the derived scope", async () => {
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("should not be called");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      provider.resolveVersion({
        material: {
          scheme: "aws_secrets_manager_v1",
          secretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/openai-api-key",
          versionId: "aws-version-2",
          source: "managed",
        },
        externalRef:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/openai-api-key",
        providerVersionRef: "aws-version-2",
        context: {
          companyId: "company-1",
          secretId: "secret-1",
          secretKey: "openai-api-key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);
  });

  it("warns when AWS provider configuration is incomplete and blocks managed writes", async () => {
    delete process.env.PAPERCLIP_SECRETS_AWS_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID;
    delete process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID;

    const provider = createAwsSecretsManagerProvider();
    const health = await provider.healthCheck();

    expect(health.status).toBe("warn");
    await expect(
      provider.createSecret({
        value: "super-secret-value",
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 1,
        },
      }),
    ).rejects.toThrow(/PAPERCLIP_SECRETS_AWS_REGION|AWS_REGION/i);
  });

  it("deletes only Paperclip-managed AWS secrets", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
      },
    });

    await provider.deleteOrArchive({
      mode: "delete",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
        versionId: null,
        source: "managed",
      },
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });
    await expect(
      provider.deleteOrArchive({
        mode: "delete",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
        material: {
          scheme: "aws_secrets_manager_v1",
          secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
          versionId: null,
          source: "managed",
        },
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);
    await provider.deleteOrArchive({
      mode: "delete",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
        versionId: "linked-version-7",
        source: "external_reference",
      },
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });

    expect(calls).toEqual([
      {
        op: "deleteSecret",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          RecoveryWindowInDays: 30,
        },
      },
    ]);
  });
});
