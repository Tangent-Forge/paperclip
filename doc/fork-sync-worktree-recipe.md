# Fork sync worktree recipe

Current topology:
- fork remote: `origin`
- source remote: `upstream`
- default branch: `master`
- fork worktree: `/Users/tangentforge/tangent-forge/repos/tf-pc`
- upstream sync worktree: `/Users/tangentforge/tangent-forge/repos/tf-pc-sync`
- sync branch: `sync/upstream-master`

## Fork work lane
Use this for your own Paperclip changes.

```sh
cd /Users/tangentforge/tangent-forge/repos/tf-pc
git switch master
git pull --ff-only origin master
git switch -c feat/<your-change>
# edit / test / commit
git push -u origin feat/<your-change>
```

## Upstream sync lane
Use this only to merge `paperclipai/paperclip` changes into your fork.

```sh
cd /Users/tangentforge/tangent-forge/repos/tf-pc-sync
git fetch --all --prune
git fetch upstream
git merge --no-ff upstream/master
```

If the merge touches generated files or lockfiles:

```sh
pnpm install --lockfile-only
git add pnpm-lock.yaml
git diff --check --cached
git commit -m "sync: merge upstream/master"
git push -u origin sync/upstream-master
```

## Throwaway lane
Use this for scratch experiments only.

```sh
git worktree add ../tf-pc-throwaway -b scratch/<name> origin/master
```

## Rules
- Push your work to `origin`
- Pull source updates from `upstream`
- Never assume `main`; this repo uses `master`
- Keep sync work isolated from the fork worktree

## Tiny shell helper

Paste this into your shell config if you want a quick shortcut:

```sh
alias tfpc='cd /Users/tangentforge/tangent-forge/repos/tf-pc'
alias tfpcsync='cd /Users/tangentforge/tangent-forge/repos/tf-pc-sync'

sync_tfpc_upstream() {
  cd /Users/tangentforge/tangent-forge/repos/tf-pc-sync || return
  git fetch --all --prune && git fetch upstream && git merge --no-ff upstream/master
}
```

Usage:
- `tfpc` → main fork worktree
- `tfpcsync` → upstream sync worktree
- `sync_tfpc_upstream` → fetch and merge upstream into the sync branch

## Current verified resolution

Verified on the live repo state:
- `/Users/tangentforge/tangent-forge/repos/tf-pc` is clean on `master` and tracks `origin/master`
- `/Users/tangentforge/tangent-forge/repos/tf-pc-sync` is clean on `sync/upstream-master` and tracks `origin/sync/upstream-master`
- `origin` is the fork remote and `upstream` is the source remote
- the repository uses `master` as the default branch name, not `main`
- the upstream integration lane was merged successfully in the sync worktree, conflict resolution completed, lockfile regeneration was performed, and the result was pushed back to the fork

Why this structure exists:
- keeps your personal fork work isolated from source-sync churn
- makes upstream merges explicit and low-risk
- avoids mixing custom fork edits with upstream conflict resolution
- gives you a repeatable place to resolve generated-file and lockfile changes before pushing
