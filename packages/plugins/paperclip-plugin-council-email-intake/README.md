# Council Email Intake plugin

Council Email Intake receives a signed Gmail relay payload, applies deterministic sender/recipient/subject filters, and creates deduplicated Paperclip issues in the configured company.

## Company and secret scope

Configuration is company-scoped. Every webhook, API request, configuration read, and secret resolution must carry the same explicit company ID. The worker rejects missing, unconfigured, or mismatched company scope; it never falls back to another company's configuration or signing secret.

## Database namespace and lifecycle

The manifest derives the PostgreSQL namespace `plugin_council_email_intake_f6365ccdd0` from plugin key `paperclipai.council-email-intake` and namespace slug `council_email_intake`. Migration objects are fully qualified into that namespace; the plugin does not create or mutate objects in `public`.

The migration is append-only after release. Fresh installs create the namespace tables deterministically, and upgrades apply only new migration files after checksum verification of prior applied files.

Disabling or ordinary uninstalling the plugin preserves its registry record, configuration, state, job history, and namespaced database data for reinstall. A host `purge=true` uninstall hard-deletes registry-owned rows, configuration, state, and job data, but the current plugin database service does not automatically drop the PostgreSQL namespace. Namespace deletion therefore remains an explicit database-administration operation and is not performed by this plugin.
