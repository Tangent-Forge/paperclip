# Paperclip upstream-adoption deployment provenance

Status: preparation only. No live process, service unit, database, deployment symlink, or production SHA was changed by this project.

## Repository and branch anchors

| Item | Evidence |
| --- | --- |
| Upstream baseline | `upstream/master` = `d1cd9c37f49e21e0f248918bce24cff137e3802d` |
| TF origin baseline | `origin/master` = `61bd44a07b53245c88d7158c073481e33b0bdede` |
| Merge base | `5c117257845a832c94311422d53a1026c05b806a` |
| Integration worktree | `/home/tfhub/tangent-forge/worktrees/paperclip-upstream-adoption-20260818` |
| Integration branch | `sync/upstream-adoption-20260818` |
| Integration branch starting SHA | `d1cd9c37f49e21e0f248918bce24cff137e3802d` |

The repositories diverge by `223` TF-only commits and `959` upstream-only commits (`origin/master...upstream/master`). The integration branch was created directly from upstream and has not been merged to TF master, pushed, deployed, or used to restart Paperclip.

## Authoritative live process

| Item | Evidence |
| --- | --- |
| Deployment pointer | `/home/tfhub/paperclip-deploy-current` -> `/home/tfhub/tangent-forge/worktrees/paperclip-deploy-pr90-human-decisions-b9ffc2634e826d6f7e2cf0ceecdcd446500ae381` |
| Live repository SHA | `b9ffc2634e826d6f7e2cf0ceecdcd446500ae381` |
| Listener | `127.0.0.1:3100`, PID `1489`, executable `/home/tfhub/.nvm/versions/node/v26.4.0/bin/node` |
| Process cwd | `/home/tfhub/tangent-forge/worktrees/paperclip-deploy-pr90-human-decisions-b9ffc2634e826d6f7e2cf0ceecdcd446500ae381/server` |
| Owner | user-systemd cgroup `/user.slice/user-1000.slice/user@1000.service/app.slice/paperclip.service` |
| Parent chain | PID `1489` -> user systemd PID `539` -> PID `1` |
| Read-only health readback | `status=ok`, version `0.3.1`, `deploymentMode=local_trusted`, `deploymentExposure=private`, `authReady=true` |
| Proxy units | `paperclip-proxy.service` and `paperclip-proxy-loopback.service` were active at audit time |

The system-level `paperclip.service` query is not authoritative for this instance; the process is owned by the user systemd manager. The existing tracker item `PAPERCLIP-SERVICE-UNAVAILABLE-20260818` conflicts with this readback and was not mutated or resolved.

Production remains pinned to `b9ffc2634e826d6f7e2cf0ceecdcd446500ae381` until a separate cutover approval.

## Preservation record

All 24 registered worktrees were inventoried. Eight were dirty and contained 25 non-ignored untracked files. The preservation root is:

`/home/tfhub/artifacts/paperclip-upstream-adoption-20260818T204414Z-wip-preservation`

It contains `worktree-inventory.tsv`, per-worktree status/diff captures, and copies of every non-ignored untracked file. The source worktrees were not stashed, reset, cleaned, or edited by the preservation pass.
