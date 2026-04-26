---
title: Secrets Management
summary: Master key, encryption, and strict mode
---

Paperclip encrypts secrets at rest using a local master key. Agent environment variables that contain sensitive values (API keys, tokens) are stored as encrypted secret references.

## Default Provider: `local_encrypted`

Secrets are encrypted with a local master key stored at:

```
~/.paperclip/instances/default/secrets/master.key
```

This key is auto-created during onboarding. The key never leaves your machine.
Paperclip best-effort enforces `0600` permissions when it creates or loads the
key file. `paperclipai doctor` and the provider health API warn when the file is
readable by group or other users.

Back up the key file together with database backups. A database backup without
the key cannot decrypt local secrets, and a key backup without the database
metadata is not enough to restore named secret versions.

## Configuration

### CLI Setup

Onboarding writes default secrets config:

```sh
pnpm paperclipai onboard
```

Update secrets settings:

```sh
pnpm paperclipai configure --section secrets
```

Validate secrets config:

```sh
pnpm paperclipai doctor
pnpm paperclipai secrets doctor --company-id <company-id>
```

### Environment Overrides

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | 32-byte key as base64, hex, or raw string |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | Custom key file path |
| `PAPERCLIP_SECRETS_STRICT_MODE` | Set to `true` to enforce secret refs |

## Strict Mode

When strict mode is enabled, sensitive env keys (matching `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

Recommended for any deployment beyond local trusted.

Authenticated deployments default strict mode on unless explicitly overridden by
configuration or `PAPERCLIP_SECRETS_STRICT_MODE=false`.

## External References

Provider-owned secrets can be linked without copying values into Paperclip by
using `managedMode: "external_reference"` plus a provider `externalRef`.
Paperclip stores metadata and a non-sensitive fingerprint, never the value.
Runtime resolution remains server-side and binding-enforced.

The built-in AWS, GCP, and Vault provider IDs currently accept external
reference metadata, but runtime resolution requires provider configuration in the
deployment. Their provider health check reports this as a warning until
configured.

## Migrating Inline Secrets

If you have existing agents with inline API keys in their config, migrate them to encrypted secret refs:

```sh
pnpm paperclipai secrets migrate-inline-env --company-id <company-id>
pnpm paperclipai secrets migrate-inline-env --company-id <company-id> --apply

# low-level script for direct database maintenance
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

Use the CLI command for normal operations because it goes through the Paperclip
API, creates or rotates secret records, and updates agent env bindings with
audit logging.

## Portable Declarations

Company exports include only environment declarations. They do not include
secret IDs, provider references, encrypted material, or plaintext values.

```sh
pnpm paperclipai secrets declarations --company-id <company-id> --kind secret
```

Before importing a package into another instance, use those declarations to
create local values or link hosted provider references in the target deployment.
For hosted providers such as AWS Secrets Manager, the hosted provider remains
the value custodian; Paperclip stores metadata and provider version references,
not provider credentials or plaintext secret values.

## Secret References in Agent Config

Agent environment variables use secret references:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "8f884973-c29b-44e4-8ea3-6413437f8081",
      "version": "latest"
    }
  }
}
```

The server resolves and decrypts these at runtime, injecting the real value into the agent process environment.
