---
title: Secrets
summary: Secrets CRUD
---

Manage encrypted secrets that agents reference in their environment configuration.

## List Secrets

```
GET /api/companies/{companyId}/secrets
```

Returns secret metadata (not decrypted values).

## Create Secret

```
POST /api/companies/{companyId}/secrets
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

The value is encrypted at rest. Only the secret ID and metadata are returned.

To link a provider-owned secret without copying the value into Paperclip, create
an external-reference secret:

```json
{
  "name": "prod-stripe-key",
  "provider": "aws_secrets_manager",
  "managedMode": "external_reference",
  "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/stripe",
  "providerVersionRef": "version-id-or-label"
}
```

Paperclip stores the provider reference and a non-sensitive fingerprint only.
The value is resolved, when the provider is configured, through the server
runtime path that enforces binding context and records access events.

## Provider Health

```
GET /api/companies/{companyId}/secret-providers/health
```

Returns provider setup diagnostics, warnings, and local backup guidance. Health
responses must not include secret values or provider credentials.

## Update Secret

```
POST /api/secrets/{secretId}/rotate
{
  "value": "sk-ant-new-value..."
}
```

Creates a new version of the secret. Agents referencing `"version": "latest"` automatically get the new value on next heartbeat.

## Using Secrets in Agent Config

Reference secrets in agent adapter config instead of inline values:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "{secretId}",
      "version": "latest"
    }
  }
}
```

The server resolves and decrypts secret references at runtime, injecting the real value into the agent process environment.
