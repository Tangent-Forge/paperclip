# Paperclip Fork Health and Alignment

## Purpose

Keep the Tangent Forge Paperclip fork understandable, reviewable, and safe to
operate while it remains a fork of `paperclipai/paperclip`.

## Current baseline (2026-07-19)

- Upstream: `paperclipai/paperclip:master`.
- Fork authority: `Tangent-Forge/paperclip:master`.
- Common ancestor: `5c117257845a832c94311422d53a1026c05b806a`.
- Divergence at audit: fork 69 commits ahead; upstream 401 commits ahead.
- TF-Home Paperclip runs locally on port 3100 from the Paperclip checkout.
- The running service must be moved to a clean, pinned deployment worktree
  before any future deployment change.

## Operating model

1. Upstream is read-only and is never merged directly into a developer
   worktree.
2. `origin/master` is the only approved Tangent Forge baseline.
3. Features use focused PRs; stacked PRs merge from base to dependent.
4. Upstream intake is monthly, capped at roughly 100 commits or one coherent
   upstream release train.
5. The deployment source is a clean worktree pinned to a recorded
   `origin/master` SHA. Dirty developer worktrees are preserved, never deployed.

## Remediation sequence

1. Preserve and inventory every dirty worktree, untracked path, local branch,
   and open PR. No cleanup occurs without a recorded disposition.
2. Land PR #13 after CI verification, then rebase/triage PR #8 as the current
   integration train. Compare PR #10 with that train; close it only when its
   fix is proven included or transplanted.
3. Land MCP bridge PR #11 before stacked PR #12; rebase each on the current
   fork master and run package-specific tests.
4. Create the deployment worktree and deployment receipt process under a
   separate service-change approval. Do not restart the current service until
   that gate is approved.
5. Run four monthly upstream batches, each with an evidence report, reviewable
   sync PR, test gate, rollback SHA, and deployment receipt.

## Guardian and cadence

`pnpm fork:health` is the read-only evidence collector. The Agent Systems Hub
policy defines its required fields and escalation thresholds.

- Daily 08:00 America/Chicago: service, deployment, and dirty-worktree check.
- Weekly Monday 09:00 America/Chicago: PR/branch/worktree hygiene review.
- First business Monday monthly at 09:00 America/Chicago: upstream intake
  proposal and next-batch recommendation.
- Quarterly: full core-vs-plugin and fork-divergence review.

The guardian may create a review task only when separately authorized. It never
merges, pushes, restarts services, changes configuration, or deletes branches.
