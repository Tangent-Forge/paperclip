# 2026-09-09 Decision / Gate System remediation (implementation plan)

## Authority

Owner approved remediation per audit
`artifacts/decision-gate-system-audit-20260909/AUDIT.md` and chat authorization.
Does **not** authorize: force-push, ENABLE STRICT, live pin deploy, mass-wake,
weakening review/secret-scan.

## Live baseline (Phase 0)

| Item | Value |
|---|---|
| Live pin commit | `4d36168994032ed53d152ee1e4bde496d0c6a770` |
| Live worktree | `~/tangent-forge/worktrees/paperclip-deploy-linear-runtime-master-20260827` |
| origin/master | `7d46213f5` (includes ODP PR #148 merge) |
| ODP on live pin | **No** — merge ≠ deploy |
| STRICT | **Not enabled**; default warn; separate owner sentence required |
| PAP-3044 H1 | Accepted interaction `c710fb98-…` @ 2026-09-09T16:02:33Z |
| Next LMO leaf | PAP-3253 already `in_progress` (authority comment bound) |

## This branch (code)

1. `packages/shared/src/acceptance-lanes.ts` — lane states, path-class classifier,
   bind answered interaction → lane, satisfied-blocker filter, disposition surface rule.
2. Tests in `acceptance-lanes.test.ts` (docs-only runtime N/A; non-waivable review;
   done-edge filter; disposition only in_progress).
3. Export from `packages/shared/src/index.ts`.
4. `server/src/services/issues.ts` — do not project `missing_successful_run_disposition`
   unless issue status is `in_progress`.
5. `skills/paperclip/SKILL.md` — authority ladder + ownership + lane notes.

## Already on master (PR #148) — not reimplemented

- ownerGuidance schema + warn/strict evaluator
- Human Decisions lane pure filter (disposition excluded)
- UI blockedInbox agent-ops variants

## Still deferred to follow-on PRs / after advisory deploy

- Auto-prune `blockedByIssueIds` when blocker becomes done (pure helper exists;
  wire + route tests in follow-on)
- Persist acceptance lane map on issue document at interaction accept
- Liveness twin mint already has open-existing guard; further source-repair-first
  path if still noisy after pin cutover
- Disposition reconciler job that writes dispositions (vs only hiding attention)
- ENABLE STRICT + pin cutover to master tip containing this branch

## Deploy sequence (owner gates)

1. Review + merge this PR normally (exact-head review, tests, secret-scan).
2. Advisory pin cutover only after owner deploy sentence + rollback note.
3. ENABLE STRICT only after advisory report + separate owner sentence.
