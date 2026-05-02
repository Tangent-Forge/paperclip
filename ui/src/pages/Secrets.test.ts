// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { SecretProviderDescriptor } from "@paperclipai/shared";
import {
  getAwsManagedPathPreview,
  getCreateProviderBlockReason,
} from "./Secrets";
import type { SecretProviderHealthResponse } from "../api/secrets";

const awsProvider: SecretProviderDescriptor = {
  id: "aws_secrets_manager",
  label: "AWS Secrets Manager",
  requiresExternalRef: false,
  supportsManagedValues: true,
  supportsExternalReferences: true,
  configured: true,
};

describe("Secrets page provider helpers", () => {
  it("previews the derived AWS managed path from provider health details", () => {
    const health: SecretProviderHealthResponse = {
      providers: [
        {
          provider: "aws_secrets_manager",
          status: "ok",
          message: "AWS Secrets Manager provider is configured",
          details: {
            prefix: "paperclip",
            deploymentId: "prod-us-1",
          },
        },
      ],
    };

    expect(
      getAwsManagedPathPreview({
        provider: awsProvider,
        health,
        companyId: "company-123",
        secretKeySource: "Anthropic API Key",
      }),
    ).toBe("paperclip/prod-us-1/company-123/anthropic-api-key");
  });

  it("blocks unconfigured providers before create submission", () => {
    expect(
      getCreateProviderBlockReason(
        { ...awsProvider, configured: false },
        "managed",
        null,
      ),
    ).toBe("AWS Secrets Manager is not configured in this deployment.");
  });

  it("blocks provider modes the backend does not support", () => {
    expect(
      getCreateProviderBlockReason(
        {
          id: "local_encrypted",
          label: "Local encrypted (default)",
          requiresExternalRef: false,
          supportsManagedValues: true,
          supportsExternalReferences: false,
          configured: true,
        },
        "external",
        null,
      ),
    ).toBe("Local encrypted (default) does not support linked external references.");
  });
});
