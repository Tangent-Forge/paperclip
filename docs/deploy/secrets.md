---
title: Secrets Management
summary: Master key, encryption, and strict mode
---

Paperclip encrypts secrets at rest using a local master key. Agent environment variables that contain sensitive values (API keys, tokens) are stored as encrypted secret references.

## Custody Boundaries

Paperclip protects secret values up to the moment they are handed to an agent
or workload:

- Storage: values are encrypted at rest by the active provider. The local
  provider keeps them encrypted with a key that never leaves the host.
- Transport: values are decrypted server-side and injected into the agent
  process environment, SSH command env, sandbox driver, or HTTP request
  immediately before the call. Paperclip does not return decrypted values to
  the board UI.
- Audit: each resolution records a non-sensitive event (secret id, version,
  provider id, consumer, outcome) without the value or provider credentials.

Once a value reaches the consuming process, Paperclip can no longer guarantee
secrecy. The agent (or sandbox, or remote host) can read the value, write it to
its own logs or transcript, or pass it to downstream tools. Treat any secret
you bind to an agent as exposed to that agent. Limit blast radius with bindings
(only bind what each agent needs), short-lived provider credentials where the
provider supports them, and rotation when an agent transcript or downstream
system might have captured a value.

## Using Secrets In Runs

Creating a company secret does not automatically create an environment variable.
You use a secret by binding it into an agent, project, environment, or plugin
configuration field that supports secret references.

For agent and project environment variables:

1. Create or link the secret in `Company Settings > Secrets`.
2. Open the agent's `Environment variables` field, or the project's `Env`
   field.
3. Add the environment variable key the process expects, such as `GH_TOKEN` or
   `OPENAI_API_KEY`.
4. Set the row source to `Secret`, select the stored secret, and choose either
   `latest` or a pinned version.

At runtime, Paperclip resolves the selected secret server-side and injects the
resolved value under the env key from the binding row. The stored secret name
can be human-readable; the binding key is what the agent process receives.

Project env applies to every issue run in that project. When a project env key
matches an agent env key, the project value wins before Paperclip injects its
own `PAPERCLIP_*` runtime variables.

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

For hosted Paperclip Cloud on AWS, see the AWS Secrets Manager operational
contract — required env vars, IAM/KMS scoping, naming and tag conventions, and
backup/rotation/incident runbooks — in `doc/SECRETS-AWS-PROVIDER.md`.

### AWS Provider Bootstrap Boundary

The AWS Secrets Manager provider cannot bootstrap itself from Paperclip
`company_secrets`. Its initial AWS access must be present before the server can
create or resolve AWS-backed company secrets.

For Paperclip Cloud, provision the server runtime IAM role/workload identity,
KMS key, deployment prefix, and non-secret `PAPERCLIP_SECRETS_AWS_*` environment
configuration before enabling AWS-backed secrets in the board UI. For
self-hosted and local runs, use the AWS SDK default credential chain: instance
profile, ECS task role, EKS IRSA/OIDC web identity, AWS SSO/shared config via
`AWS_PROFILE`, or short-lived shell credentials for local development.

Do not store AWS root credentials or long-lived IAM user access keys in
Paperclip secrets. Bootstrap material belongs in infrastructure IAM/workload
identity, the process environment, an AWS profile, or the orchestrator secret
store.

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
