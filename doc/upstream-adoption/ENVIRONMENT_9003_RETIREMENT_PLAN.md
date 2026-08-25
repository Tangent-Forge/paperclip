# 9003 retirement and migration design

Status: design only. Owner approval selects upstream's instance-scoped
environment model. This document authorizes no production DDL, data write,
migration execution, restart, deployment, merge, or cutover.

## Approved target contract

- The Paperclip environment row and instance default are instance-scoped.
- Provider credentials and secret bindings remain company-scoped.
- Execution leases, accounting, activity, and audit attribution remain
  company-scoped.
- Company-specific provider configuration/provisioning is represented through
  supported plugin/provider/configuration contracts.
- Generic environment `config`, `env_vars`, and row identity are not required
  to be independently selectable per company absent a demonstrated future
  requirement.

9003 SQL is not part of the fresh synchronized core migration set. The 9003
historical hash remains recognized by migration-history compatibility code so
the existing live ledger is not treated as an unknown history. No historical
row is deleted, rewritten, renumbered, or replayed by this design.

## Current read-only inventory

Observed against the live Paperclip database on 2026-08-19:

| Item | Current evidence |
| --- | --- |
| Older environment | `0de79471-f411-4868-921f-84eff760ab86`, company `b7361769-54ba-4778-8d07-9e2851fedd74`, `Local`, `local`, `active` |
| Newer environment | `c90f52fa-0dfe-4ec3-9f0a-5e026ee37d71`, company `fa7fbdbd-723c-4761-81a9-cde203abf26e`, `Local`, `local`, `active` |
| Instance default | `instance_settings.default_environment_id` points to the older row |
| Lease count at approved audit | 25,805 total: 25,788 older-row leases and 17 newer-row leases |
| Lease count at latest design read | 25,828 total: 25,811 older-row leases and 17 newer-row leases |
| Other direct references | No agent default, custom-image session/template, issue JSON, project policy JSON, or execution-workspace metadata reference to either ID was found |
| Environment payloads | Both `config` and `env_vars` are `{}`; non-secret fingerprints match. Metadata is non-empty and must be compared/preserved explicitly. |
| Managed-resource bindings | No `built_in_managed_resources` environment binding rows were found |
| 9003 history | Historical hash is present in `drizzle.__drizzle_migrations` with `created_at=1785391098109` |

The count changed while the live Paperclip process continued to operate. The
cutover invariant is therefore “preserve every lease row present in the
cutover transaction,” not “preserve exactly 25,805 rows.” The 25,805 count is
retained as the owner-approved audit baseline.

## Canonical identity selection

The dry-run default is to retain the older row
`0de79471-f411-4868-921f-84eff760ab86` as the canonical upstream environment
identity because it is the oldest row and is already the instance-settings
default. The newer row is not deleted until all reference and provider-state
checks pass.

The migration must stop for owner review if any of the following is true:

- the older row is missing or no longer the instance default;
- either row has non-empty or divergent `config` or `env_vars`;
- metadata contains provider-owned state that cannot be merged losslessly;
- a new direct or JSON reference is discovered;
- an active custom-image session/template or provider lease requires distinct
  environment identity;
- global uniqueness would reject another existing environment name/driver.

Creating a new UUID is the fallback only if the older identity cannot be
retained. In that case, the new-to-canonical mapping and every foreign/JSON
reference must be recorded before any write approval.

## Reference inventory and remapping design

The dry-run inventory must query all of the following, before and inside the
approved cutover transaction:

1. `agents.default_environment_id`;
2. `environment_leases.environment_id`, grouped by company, status, lease
   policy, provider, and provider lease ID;
3. `execution_workspaces.metadata->>'environmentId'` and any future
   workspace environment-selection fields;
4. `environment_custom_image_setup_sessions.environment_id`, including
   active/starting/waiting/capturing sessions;
5. `environment_custom_image_templates.environment_id`, including active,
   superseded, revoked, and provider template references;
6. `issues.execution_workspace_settings->>'environmentId'`, plus
   `execution_policy`, `execution_state`, and any future JSON environment
   fields;
7. `projects.execution_workspace_policy->>'environmentId'` and project
   environment policy fields;
8. `instance_settings.default_environment_id`;
9. setup-token/session/transport records and plugin-owned tables discovered by
   schema and code search;
10. foreign keys and indexes discovered from `pg_constraint`, `pg_indexes`,
    and `information_schema` at cutover.

For each reference, the dry run produces:

```text
reference table/field | company_id | source id | old environment id |
canonical environment id | remap required | reason | rollback value
```

The write design is one transaction with an explicit mapping table. It updates
only references that point to the secondary ID, preserves company IDs and all
lease payload/attribution fields, then validates that no reference points to
the secondary ID before removing the secondary row. JSON fields are updated
with typed JSON transformations and before/after checksums, not string replace.

No `ON DELETE CASCADE` path may be used to remove the secondary row before
reference remapping. Existing `environment_leases.environment_id` is nullable
with `ON DELETE SET NULL`, but the cutover must not rely on that fallback: all
25,805 approved-baseline leases and any later rows must retain the canonical
environment ID.

## Lease and attribution preservation

The transaction must assert:

- pre-count equals the cutover snapshot count;
- post-count equals pre-count;
- every lease ID exists exactly once after remapping;
- `company_id`, status, lease policy, provider, provider lease ID, timestamps,
  cleanup fields, issue IDs, workspace IDs, heartbeat IDs, and metadata are
  byte-equivalent except for `environment_id` where the secondary mapping is
  used;
- per-company and per-status counts are unchanged;
- no lease points to a deleted or unknown environment;
- activity/audit joins still resolve to the same company.

The comparison includes the 25,805 approved baseline and dynamically includes
rows created before the transaction snapshot. Any concurrent write policy
must be decided operationally: pause scheduling in an approved maintenance
window or use a transaction/isolation strategy that prevents a write from
escaping the inventory/remap set. This plan does not authorize that pause or
any live write.

## Secret and provider isolation

Before migration, verify read-only:

- all environment secret-binding rows and their `company_id` values;
- all referenced secret IDs/keys by company, without reading secret values;
- all provider/plugin bindings, provider lease IDs, custom-image templates,
  setup sessions, and managed-resource records;
- no binding for company A becomes addressable through company B after the
  environment ID collapse;
- environment routes and plugin SDK calls require explicit company context
  wherever secrets or provider state are resolved.

The target contract permits the shared Paperclip environment row to be
instance-scoped only because company-scoped secrets, leases, activity, and
provider state remain separately enforced. Provider-specific configuration
that cannot safely become instance-global must move to a plugin/provider-owned
company-scoped table or supported binding contract before cutover.

## Metadata and provider-owned state

Metadata is non-empty on both current rows even though `config` and `env_vars`
are empty. The migration must classify every metadata key as:

- upstream instance-owned and safe to retain;
- company/provider-owned and moved to a supported binding/plugin record;
- historical/audit-only and retained without runtime interpretation; or
- unknown, which blocks the migration.

The canonical row's metadata is not overwritten by the secondary row. A
deterministic merge is permitted only for keys explicitly classified as
instance-owned and with an owner-approved conflict rule. Provider-owned
metadata must be copied to the provider contract, not silently concatenated.

## Global schema/index transition

The upstream transition must be validated on a clone/scratch database first:

1. apply the clean upstream migration sequence to a copy of a production
   snapshot, without connecting the live service;
2. run the inventory and mapping dry run;
3. verify the upstream global local-driver, managed-sandbox, and name indexes;
4. verify no duplicate global names or local/managed-sandbox slots would make
   index creation fail;
5. verify `instance_settings.default_environment_id` points to the canonical
   row;
6. run all environment, agent-selection, lease, custom-image, secret-binding,
   plugin-host, and authorization tests against the transformed clone;
7. rehearse rollback on the clone and compare all reference/lease checksums.

The 13.2M-row warning belongs to 9001's active wakeup unique index, not the
9003 environment-row collapse. No `CREATE INDEX`, `ALTER TABLE`, or other DDL
is authorized by this plan.

## Dry-run receipt and go/no-go gates

The pre-cutover dry run must produce a signed/immutable receipt containing:

- source live SHA/process/deployment identity;
- database snapshot identity and transaction timestamp;
- complete environment/reference inventory;
- canonical mapping and metadata classification;
- secret/provider isolation results without secret values;
- lease count/checksum and per-company/status breakdown;
- index/constraint validation;
- transformed-clone tests and rollback rehearsal;
- exact SQL/migration version to be approved;
- expected post-migration verification queries.

Go requires zero unexplained references, zero lease-count/checksum drift, no
provider-state loss, successful clone rollback, and separate owner approval
for production DDL/data writes. Any mismatch is a stop, not an automatic
fallback.

## Rollback design

Rollback is not a journal-only revert. Before writes, retain a transactionally
consistent snapshot and the complete old-to-canonical mapping. If post-write
verification fails before commit, abort the transaction. If failure occurs
after commit, restore from the snapshot or execute an owner-approved reverse
mapping that:

- recreates the secondary company row with a stable recorded UUID;
- restores all remapped references by lease/reference mapping;
- restores metadata/provider bindings from the pre-cutover receipt;
- restores the company-scoped indexes and FK;
- revalidates instance/default and company authorization behavior.

The reverse path must be rehearsed on the clone before production approval. No
production rollback operation is included in this preparation branch.

## Post-migration verification

After a separately approved cutover, verify read-only:

- exactly one intended instance-scoped Local row and correct instance default;
- upstream global indexes/constraints exist with expected definitions;
- no secondary environment ID remains in direct or JSON references;
- lease total, per-company/status breakdown, IDs, attribution, and checksums
  are unchanged;
- secret-binding company scopes and provider/plugin state are unchanged;
- custom-image/session/template state is valid;
- agent/environment selection, issue/workspace/project policy, and plugin-host
  authorization tests pass;
- live Paperclip health, scheduler state, and one bounded non-mutating readback
  are verified against the new deployment SHA.

Production remains pinned to the existing SHA until all of these gates and a
separate cutover approval are complete.
