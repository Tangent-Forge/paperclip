# Phases 5–8: Stack & Flow Evaluation

> **Date:** 2026-06-15
> **Branch:** `integration/paperclip-update-20260615`
> **Head commit:** `cb62d818` (test: stabilize paperclip phase 4 verification)
> **Commits ahead of upstream:** 18 (post-upstream-merge)
> **Live Paperclip:** `com.tangentforge.paperclip` launchd, port 3100, status=ok
> **Live GBrain:** `com.tangentforge.gbrain` launchd, port 3131, status=ok

---

## Phase 5 — Push and PR

### Required Tools & Skills
| Tool | Use |
|------|-----|
| `terminal` (git) | `git push origin integration/paperclip-update-20260615`, force-push if rebased |
| `terminal` (gh CLI) | `gh pr create` with `--template`, `--base`, `--head`, `--body-file` |
| `read_file` | Read `.github/PULL_REQUEST_TEMPLATE.md` to fill all 7 sections |
| `write_file` | Compose filled PR body to a temp file for `--body-file` |
| `terminal` | `gh pr view` to confirm creation, get PR number/URL |
| `mcp_linear_*` | (optional) create a Linear issue tracking the PR |
| `mcp_gbrain_put_page` | Record PR metadata in brain for future reference |

**Skills:** `github-operations`, `gstack-ship`

### Efficiency Groupings
1. **Sequential chain (must be ordered):**
   - `git push` → wait for remote ref → `gh pr create` → confirm
2. **Parallel pre-work (can run simultaneously):**
   - Read PR template + read recent commit log → draft PR body
   - Check for duplicate/conflicting PRs on upstream (`gh pr list --repo paperclipai/paperclip`)
3. **Post-creation (parallel):**
   - Record in GBrain + update Linear (if tracking) simultaneously

### Risk Points & Controls
| Risk | Control |
|------|---------|
| Push rejected (non-fast-forward) | Pre-flight: `git fetch origin` + `git log --oneline origin/...` to detect divergence |
| PR body misses required sections | Parse template programmatically, validate all 7 checklist items present before submit |
| Upstream CI doesn't trigger on fork PRs | Verify branch name matches upstream CI patterns; add comment noting fork origin |
| Duplicate PR already open | `gh pr list --state open --author batkins33` before creation |
| Force-push breaks open review | Never force-push after PR is open without commenting first |

### Recommended Sub-Agent Roles
- **PR Drafter** (writing skill): fills template sections from commit history + diff analysis
- **GitHub Operator** (`github-operations` skill): executes push + PR creation + verification

---

## Phase 6 — Live Update Preparation

### Required Tools & Skills
| Tool | Use |
|------|-----|
| `terminal` | Inspect migration files (`packages/db/drizzle/`, plugin migrations) |
| `terminal` | `pnpm db:generate` to check for pending migrations |
| `read_file` | Read schema files, migration SQL, `doc/DATABASE.md` |
| `terminal` | Check service topology: `launchctl list \| grep tangent`, `curl` health endpoints |
| `terminal` | Verify WSL TF-007 build lane: `ssh` or `tailscale ssh` to run Linux tests |
| `terminal` | Document rollback commands (launchd unload, git revert, pglite restore) |
| `write_file` | Write the update runbook to `doc/plans/` or a runbook file |
| `mcp_gbrain_put_page` | Store the preparation checklist in brain |
| `mcp_linear_save_issue` | Create a "Deploy preparation" tracking issue |

**Skills:** `gstack-plan-eng-review`, `systematic-debugging`

### Efficiency Groupings
1. **Parallel discovery (batch first):**
   - Migration analysis: diff schema files, check `db:generate` output
   - Service topology: `launchctl list`, `curl` health endpoints, check PGlite data dir
   - Dependency audit: `pnpm audit`, `pnpm outdated` for the changed packages
2. **Sequential dependency chain:**
   - Migration check → rollback plan → restart sequence → runbook document
   - Each step depends on findings from the previous
3. **Cross-machine coordination (TF-007):**
   - Linux build verification must complete before live update approval
   - Chain: trigger WSL build → wait for result → gate Phase 7

### Risk Points & Controls
| Risk | Control |
|------|---------|
| Unapplied DB migrations crash on restart | Pre-flight: `pnpm db:generate --check` (dry run) + verify no pending SQL diffs |
| PGlite data corruption on version bump | Snapshot `data/pglite` directory before any restart (`tar -czf`) |
| launchd auto-restart fights manual control | `launchctl unload` before manual ops; `launchctl load -w` to re-enable |
| WSL build lane unavailable | Fallback: run Linux tests in Colima Docker on Mac hub |
| Plugin migration (linear-sync) fails | Test migration in isolation: `pnpm --filter linear-sync` + verify SQL idempotency |
| GBrain unavailable during update | GBrain is independent (port 3131, separate launchd) — low coupling |

### Recommended Sub-Agent Roles
- **DB Analyst**: inspects migrations, verifies idempotency, writes rollback SQL
- **DevOps Preparer**: documents service topology, restart sequence, launchd commands
- **Cross-Machine Coordinator**: manages WSL TF-007 build verification, gates approval

---

## Phase 7 — Approved Live Update (Stop/Restart)

### Required Tools & Skills
| Tool | Use |
|------|-----|
| `terminal` | `launchctl unload ~/Library/LaunchAgents/com.tangentforge.paperclip.plist` |
| `terminal` | `launchctl load -w ~/Library/LaunchAgents/com.tangentforge.paperclip.plist` |
| `terminal` | Apply migrations: `pnpm db:migrate` or equivalent Drizzle command |
| `terminal` | Health verification loop: `curl -s http://localhost:3100/api/health` (poll 5x, 10s interval) |
| `terminal` | Process verification: `ps aux \| grep paper`, PID tracking |
| `terminal` | Smoke test: `curl http://localhost:3100/api/companies` |
| `terminal` | Rollback trigger: `launchctl unload` + `git checkout <prev>` + restart |
| `write_file` | Write update execution log |
| `mcp_gbrain_add_timeline_entry` | Record update event in brain timeline |
| `terminal` | Backup first: `tar -czf ~/backups/pglite-pre-update-$(date +%s).tar.gz data/pglite` |

**Skills:** `gstack-land-and-deploy`, `gstack-canary`, `systematic-debugging`

### Efficiency Groupings
1. **Pre-flight atomic operation (do all or none):**
   ```
   Backup PGlite → Unload launchd → Apply migrations → Load launchd → Health check
   ```
   This MUST be a single uninterrupted sequence. If any step fails after unload, 
   execute rollback immediately.
   
2. **Parallel verification (after health=ok):**
   - API smoke tests (curl companies, curl agents)
   - UI check (curl localhost:3100 for HTML response)
   - GBrain sync check (verify brain still accessible)

3. **Sequential gate:**
   - Health must return `{"status":"ok"}` within 30s of load — or auto-rollback triggers

### Risk Points & Controls (HIGH PRIORITY)
| Risk | Control |
|------|---------|
| **Service fails to start post-update** | Tight loop: poll health endpoint 6x at 5s intervals = 30s max. If no `200`, `launchctl unload` + restore backup + restart old version |
| **Migration fails mid-apply** | PGlite is single-file: restore from tar backup. No partial migration state possible with file-level restore |
| **launchd respawn conflict** | Always `unload` before manual ops. Never `kill` the process directly — launchd will respawn the old version |
| **Port 3100 stuck in TIME_WAIT** | After unload, wait 2s + check `lsof -i :3100` before load |
| **Memory pressure from Node 26** | Monitor with `top -l 1 -pid <PID>` post-start; if RSS > 500MB, log warning |
| **Cloudflare tunnel breaks** | Tunnel config points to localhost:3100 — independent of Paperclip version. Verify `curl https://paperclip.tf-hub.dev/api/health` post-restart |
| **Rollback decision latency** | Pre-write rollback script. Decision gate: if health check fails at 30s, execute rollback automatically (no human prompt needed) |

### Recommended Sub-Agent Roles
- **Deployment Executor** (`gstack-land-and-deploy`): runs the atomic update sequence with pre-written rollback
- **Canary Monitor** (`gstack-canary`): polls health endpoints, triggers rollback on threshold breach
- **Incident Logger**: records every step with timestamps for post-mortem if needed

---

## Phase 8 — Maintenance Plan

### Required Tools & Skills
| Tool | Use |
|------|-----|
| `write_file` | Write `doc/plans/2026-06-15-paperclip-update-checklist.md` |
| `write_file` | Write watchdog scripts to `scripts/` |
| `terminal` (cron) | Register cron jobs via Hermes cron or `crontab` |
| `terminal` | Write launchd guardian plist for Paperclip watchdog |
| `mcp_gbrain_put_page` | Codify maintenance knowledge in brain |
| `mcp_gbrain_add_timeline_entry` | Record maintenance plan creation |
| `mcp_gbrain_add_tag` | Tag maintenance pages for future retrieval |
| `terminal` | Test watchdog scripts in dry-run mode |
| `skill_manage` | Create/update a `paperclip-ops` skill for recurring use |

**Skills:** `gstack-health`, `kanban-orchestrator`, `gstack-document-release`

### Efficiency Groupings
1. **Parallel documentation (batch):**
   - Update checklist (step-by-step for next time)
   - Runbook update (restart commands, known failure modes)
   - Brain page (searchable knowledge base entry)
   
2. **Sequential watchdog creation:**
   ```
   Write watchdog script → Test locally → Register cron/launchd → Verify it fires
   ```

3. **Batch verification setup:**
   - Health cron: `curl localhost:3100/api/health` every 5 min
   - Drift cron: compare `git rev-parse HEAD` vs deployed version weekly
   - Brain sync: import runbook into GBrain for semantic search

### Risk Points & Controls
| Risk | Control |
|------|---------|
| Watchdog false positives during planned maintenance | Add maintenance mode flag file (`/tmp/paperclip-maintenance`); watchdog skips when present |
| Cron job accumulation (silent failures) | Each watchdog writes to a log with rotation; alert if log has no entry in 2x interval |
| Brain pages go stale | Tag with `paperclip-ops` + set review date in timeline entry |
| Checklist not followed next time | Embed checklist as first section of any future update plan (template enforcement) |
| Watchdog script itself breaks on OS update | Pin script paths to absolute paths; test on each macOS major update |

### Recommended Sub-Agent Roles
- **Documentation Writer** (`gstack-document-release`): produces the checklist and runbook
- **Watchdog Builder**: writes health-check scripts, registers them, verifies firing
- **Knowledge Curator**: ensures brain entries are searchable, tagged, and cross-linked

---

## Cross-Phase Efficiency Summary

### Tool Chain Pipelines (highest-value groupings)

```
┌─────────────────────────────────────────────────────────────────┐
│ PIPELINE A: Push-to-PR (Phase 5)                                │
│                                                                  │
│ read_file(template) ──┐                                          │
│ terminal(git log)   ──┼── write_file(body) ── terminal(push+pr)  │
│ terminal(gh pr list)──┘                                          │
│                                                                  │
│ Est. wall-clock: 3-5 min                                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PIPELINE B: Pre-flight Assessment (Phase 6)                      │
│                                                                  │
│ terminal(db:generate) ──┐                                       │
│ terminal(launchctl)   ──┼── write_file(runbook) ── gate: approval│
│ terminal(ssh TF-007)  ──┘                                       │
│                                                                  │
│ Est. wall-clock: 15-25 min (dominated by WSL build)             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PIPELINE C: Atomic Deploy (Phase 7) — MUST BE SERIAL             │
│                                                                  │
│ backup → unload → migrate → load → health_check(6x/5s)          │
│                                                                  │
│ Rollback trigger: health < 200 at T+30s                         │
│ Est. wall-clock: 2-5 min (if clean) / 5-10 min (if rollback)    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PIPELINE D: Maintenance Codification (Phase 8)                   │
│                                                                  │
│ write_file(checklist) ─┐                                        │
│ write_file(watchdog)  ─┼── terminal(register cron) ── verify    │
│ gbrain_put_page       ─┘                                        │
│                                                                  │
│ Est. wall-clock: 10-15 min                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Parallelism Map (what runs concurrently across phases)

| Slot | Work | Agent Role |
|------|------|-----------|
| P5 + P6-prep | Push PR while starting migration analysis | GitHub Ops + DB Analyst |
| P6-WSL + P6-runbook | WSL build runs while runbook is drafted | Cross-Machine Coord + DevOps |
| P8-doc + P8-watchdog | Documentation written while watchdogs are coded | Doc Writer + Watchdog Builder |

### Critical Path
```
Phase 5 (3min) → Phase 6 gate (20min) → Phase 7 (5min) → Phase 8 (15min)
                                                                    TOTAL: ~43 min + approval wait
```

The WSL TF-007 build verification is the single longest sequential dependency. 
Parallelizing doc writing against it saves ~10 min.

---

## Service Topology Summary (for Phase 6/7 reference)

| Service | Port | Launchd Plist | Dependency |
|---------|------|---------------|------------|
| Paperclip | 3100 | `com.tangentforge.paperclip` | PGlite (embedded), Node 26 |
| GBrain | 3131 | `com.tangentforge.gbrain` | PGLite engine, OpenAI embeddings |
| Cloudflared | — | `com.tangentforge.cloudflared` | Routes `paperclip.tf-hub.dev` → :3100 |
| Hermes Gateway | — | `com.tangentforge.hermes-gateway` | Independent |
| LiteLLM | — | `com.tangentforge.litellm` | Independent (model proxy) |

**Restart order (if full stack restart needed):**
1. GBrain (3131) — no deps on Paperclip
2. Paperclip (3100) — no deps on GBrain
3. Cloudflared — auto-reconnects, no restart needed

**Coupling analysis:** Paperclip and GBrain are fully decoupled. The only shared resource is the Mac's 16GB RAM. Paperclip at ~241MB RSS leaves headroom.

---

## Migration Surface Assessment

- **Core DB migrations:** None in this branch's diff (no `packages/db/drizzle/` changes)
- **Plugin migrations:** 1 file — `packages/plugins/paperclip-plugin-linear-sync/migrations/001_linear_sync.sql`
- **Schema changes:** Schema files modified in `packages/db/src/schema/` but compiled — verify with `pnpm db:generate`
- **Risk level:** LOW — single plugin migration, core DB unchanged

---

## Recommended Agent Allocation

| Phase | Primary Agent | Supporting Agent | Oversight |
|-------|--------------|------------------|-----------|
| 5 | PR Drafter | GitHub Operator | Human reviews PR before merge |
| 6 | DB Analyst | DevOps Preparer | Cross-Machine Coord (TF-007) |
| 7 | Deployment Executor | Canary Monitor | Human approval gate before unload |
| 8 | Doc Writer | Watchdog Builder | Knowledge Curator |

**Total distinct roles:** 9 (some can be served by the same agent instance)
**Human gates required:** Phase 5 (PR review), Phase 7 (unload confirmation), Phase 8 (cron approval)
