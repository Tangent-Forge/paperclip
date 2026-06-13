# Email Ingest Router

Cloudflare Email Routing Worker for Paperclip council intake.

The Worker receives mail sent to `ingest+<agent>@<production-email-domain>`, parses the RFC822
message, maps the address tag to a Paperclip council agent, signs the canonical
JSON payload with HMAC-SHA256, and posts it to the public Paperclip routine
trigger endpoint.

## Address Routing

- `ingest+ceo@<production-email-domain>` -> `ceo`
- `ingest+cto@<production-email-domain>` -> `cto`
- `ingest+risk@<production-email-domain>` or `ingest+risk-auditor@<production-email-domain>` -> `risk`
- `ingest+hermes@<production-email-domain>` or `ingest+hermes-lead@<production-email-domain>` -> `hermes`
- `ingest+cos@<production-email-domain>` or `ingest+chief-of-staff@<production-email-domain>` -> `cos`
- unknown tags -> `DEFAULT_AGENT`

## Required Worker Secret

Set the Paperclip routine trigger secret before deploying:

```bash
pnpm exec wrangler secret put PAPERCLIP_TRIGGER_SECRET
```

The value must match the HMAC secret configured for the Paperclip public routine
trigger. Do not commit `.dev.vars` or secret values.

## Local Commands

```bash
pnpm typecheck
pnpm dev
pnpm deploy
pnpm tail
```

## Liveness Verification

Operator-visible liveness is the Cloudflare Worker log stream. Keep a tail open,
send a real email to the maintained router address, and confirm the matching
delivery id reaches `email_ingest_delivered`:

```bash
pnpm --filter @paperclipai/email-ingest-router-cf tail --format pretty
# In another terminal or mail client, send a real message to:
# ingest+cto@<production-email-domain>
```

Expected success log sequence:

```text
{"event":"email_ingest_received","deliveryId":"mail_...","agent":"cto",...}
{"event":"email_ingest_delivered","deliveryId":"mail_...","agent":"cto","status":200,...}
```

If Paperclip rejects the routine trigger, the Worker logs
`email_ingest_paperclip_post_failed` with the HTTP status and a truncated
response body, then throws so Cloudflare Email Routing can retry transient
failures.

## Production Notes

- Worker name: `email-ingest-router`
- Production email domain: use the Cloudflare Email Routing production domain
  from TF ops; the literal domain is not repeated here so repository token
  checks remain publish-safe.
- Paperclip webhook hostname: `paperclip-webhook.tf-hub.dev`
- `wrangler.toml` intentionally keeps the public routine trigger URL and default
  agent in tracked config; the authentication boundary is the untracked Worker
  secret.
- The retired IMAP bridge under `archive/email-paperclip-bridge-retired-20260608/`
  is not part of the maintained intake path. Restore it only if the Cloudflare
  Email Routing Worker cannot satisfy intake liveness requirements.
