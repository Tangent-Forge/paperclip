# Linear Sync 0.1.1 Materialized Artifact Recovery

## Runtime finding

Deploying Paperclip source does not replace an already materialized plugin package. The live
`paperclipai.linear-sync` registry record continued to execute the August 17 `0.1.0` package after
Paperclip PR #96 was merged and deployed. That package still declared `Ready for Paperclip` as its
default admission state, so database config readback alone did not prove that the worker was running
the merged Triage-only implementation.

## Recovery contract

- Publish the Triage-only implementation as plugin version `0.1.1`.
- Keep package metadata and manifest version identical.
- Install from a clean worktree at the exact merged Paperclip revision through the supported local
  plugin installer; do not overwrite the materialized `0.1.0` directory by hand.
- Preserve the existing plugin record, opaque credential reference, company, limits, failure controls,
  and Triage agent configuration.
- Keep `enabled=false` until the `0.1.1` package path, manifest defaults, worker health, config readback,
  negative admission, positive admission, routing, recovery, and duplicate/idempotency canaries pass.

The old `0.1.0` materialization remains historical rollback evidence. It is not current execution
evidence and must not be treated as proof of Triage-only behavior.
