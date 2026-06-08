#!/usr/bin/env bash
#
# sync-upstream.sh — manually trigger an upstream sync for the Tangent Forge
# fork of paperclipai/paperclip. Mirrors the logic of
# .github/workflows/upstream-sync.yml so you can test or run a sync without
# waiting for the Monday cron.
#
# What it does:
#   1. Fetches upstream master
#   2. Early-exits if there is nothing new to sync
#   3. Creates a new branch chore/upstream-sync-YYYY-MM-DD (with a rerun suffix
#      if that name already exists on origin)
#   4. Attempts a no-ff merge of upstream/master into the new branch
#   5. On clean merge: refreshes pnpm-lock.yaml and amends the merge commit if
#      the lockfile actually changed
#   6. On conflict merge: aborts the merge, prints the conflicting files, and
#      leaves the branch checked out at master HEAD for manual resolution
#
# What it does NOT do:
#   - Push the branch to origin (you decide when)
#   - Open a pull request (use `gh pr create` separately)
#
# Requirements: git, pnpm. Assumes an `upstream` remote pointing at
# https://github.com/paperclipai/paperclip.git — adds it if missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

UPSTREAM_URL="https://github.com/paperclipai/paperclip.git"

say() { printf '\n[sync-upstream] %s\n' "$*"; }

say "About to sync upstream paperclipai/paperclip into a new branch."
say "Repo root: $REPO_ROOT"

# Refuse to run on a dirty working tree — merging on top of uncommitted work is
# a great way to lose changes.
if [ -n "$(git status --porcelain)" ]; then
  echo "[sync-upstream] ERROR: working tree is dirty. Commit or stash first." >&2
  exit 1
fi

# Ensure upstream remote exists and points at the right URL.
if git remote get-url upstream >/dev/null 2>&1; then
  current="$(git remote get-url upstream)"
  if [ "$current" != "$UPSTREAM_URL" ]; then
    say "Updating upstream remote URL: $current -> $UPSTREAM_URL"
    git remote set-url upstream "$UPSTREAM_URL"
  fi
else
  say "Adding upstream remote: $UPSTREAM_URL"
  git remote add upstream "$UPSTREAM_URL"
fi

say "Fetching upstream master..."
git fetch upstream master

# Ensure local master is current with origin (the workflow does this implicitly
# via checkout; locally we should at least make sure master is checked out and
# fresh).
say "Checking out and refreshing local master from origin..."
git checkout master
git fetch origin master
git merge --ff-only origin/master || {
  echo "[sync-upstream] ERROR: local master is not fast-forwardable to origin/master." >&2
  echo "Resolve that first, then re-run." >&2
  exit 1
}

count="$(git rev-list --count master..upstream/master)"
if [ "$count" -eq 0 ]; then
  say "Nothing to sync — fork master is already at or ahead of upstream/master."
  exit 0
fi
say "$count upstream commit(s) to merge."

DATE="$(date -u +%Y-%m-%d)"
BASE_BRANCH="chore/upstream-sync-${DATE}"
BRANCH="$BASE_BRANCH"
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  BRANCH="${BASE_BRANCH}-rerun-$(date -u +%H%M)"
  say "Branch $BASE_BRANCH already exists on origin. Using $BRANCH instead."
fi

say "Creating branch $BRANCH from master..."
git checkout -b "$BRANCH" master

say "Attempting merge of upstream/master..."
if git merge --no-ff --no-edit upstream/master; then
  say "Merge succeeded cleanly."

  say "Refreshing pnpm-lock.yaml..."
  pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile

  if git diff --quiet -- pnpm-lock.yaml; then
    say "Lockfile unchanged."
  else
    say "Lockfile changed; amending merge commit to include it."
    git add pnpm-lock.yaml
    git commit --amend --no-edit
  fi

  cat <<EOF

[sync-upstream] DONE — clean merge.
  Branch:  $BRANCH
  Commits: $count merged from upstream/master
  Next:    git push origin "$BRANCH"
           gh pr create --base master --head "$BRANCH" \\
             --title "chore: sync upstream ($DATE)" \\
             --body  "Manual upstream sync. $count commit(s) merged."
EOF
else
  say "Merge conflicts encountered. Capturing conflict list and aborting merge."
  CONFLICTS="$(git diff --name-only --diff-filter=U || true)"
  git merge --abort || true

  cat <<EOF

[sync-upstream] DONE — conflicts.
  Branch:        $BRANCH (currently at master HEAD; merge was aborted)
  Commits behind: $count
  Conflicting files:
$(printf '    %s\n' $CONFLICTS)

  Next: resolve conflicts manually. For example:
    git merge upstream/master
    # edit conflicting files
    git add <files>
    git commit
    pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile
    git add pnpm-lock.yaml && git commit --amend --no-edit  # if lockfile changed
    git push origin "$BRANCH"
    gh pr create --base master --head "$BRANCH" \\
      --title "chore: sync upstream ($DATE) — conflicts" \\
      --body  "Manual upstream sync with conflicts. See branch for resolution."
EOF
fi
