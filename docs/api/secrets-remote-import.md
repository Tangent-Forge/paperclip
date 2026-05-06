---
title: Secrets Remote Import
summary: AWS Secrets Manager metadata-only remote import API
---

Remote import lets the board link existing AWS Secrets Manager entries as
Paperclip `external_reference` secrets without copying plaintext into
Paperclip.

Both routes are board-only and company-scoped. The selected provider vault must
belong to the company, use `aws_secrets_manager`, and have a selectable status
(`ready` or `warning`). Disabled, coming-soon, or cross-company vaults are
rejected.

## Preview Remote AWS Secrets

```
POST /api/companies/{companyId}/secrets/remote-import/preview
{
  "providerConfigId": "<aws-vault-uuid>",
  "query": "stripe",
  "nextToken": "optional-provider-page-token",
  "pageSize": 50
}
```

The backend calls AWS Secrets Manager `ListSecrets` only. It never calls
`GetSecretValue`, never requests `SecretString`, and never returns plaintext.

Response:

```json
{
  "providerConfigId": "<aws-vault-uuid>",
  "provider": "aws_secrets_manager",
  "nextToken": null,
  "candidates": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "remoteName": "prod/stripe",
      "name": "prod/stripe",
      "key": "prod-stripe",
      "providerVersionRef": null,
      "providerMetadata": { "name": "prod/stripe" },
      "status": "ready",
      "importable": true,
      "conflicts": []
    }
  ]
}
```

Candidate `status` values:

- `ready`: no existing exact external reference and no name/key collision.
- `duplicate`: an existing secret already has the exact provider `externalRef`.
- `conflict`: the suggested Paperclip `name` or `key` is already in use.

## Import Remote AWS Secret References

```
POST /api/companies/{companyId}/secrets/remote-import
{
  "providerConfigId": "<aws-vault-uuid>",
  "secrets": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "name": "Stripe production key",
      "key": "stripe-production-key",
      "providerVersionRef": null,
      "providerMetadata": { "name": "prod/stripe" }
    }
  ]
}
```

The import response is row-level. Ready rows become active
`external_reference` secrets with version metadata only. Exact-reference
duplicates and name/key conflicts are skipped without failing the whole request.

```json
{
  "providerConfigId": "<aws-vault-uuid>",
  "provider": "aws_secrets_manager",
  "importedCount": 1,
  "skippedCount": 1,
  "errorCount": 0,
  "results": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "name": "Stripe production key",
      "key": "stripe-production-key",
      "status": "imported",
      "reason": null,
      "secretId": "<paperclip-secret-id>",
      "conflicts": []
    }
  ]
}
```

Activity logs record aggregate counts and provider/vault ids only, not remote
secret names, ARNs, tags, or values.
