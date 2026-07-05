---
type: concept
title: Codex Desktop Wsl Config
ingested_via: 'mcp:put_page'
ingested_at: '2026-06-19T22:04:59.330Z'
source_kind: 'mcp:put_page'
---

# Codex Desktop (WSL/TF-007) — Launch Fix & MCP Consolidation

Canonical reference for how Codex Desktop is wired on **TF-007 (WSL-canonical host)**, the recurring GUI-launch breakage, and the 2026-06-19 MCP consolidation. Config lives at `/mnt/c/Users/bkat3/.codex/config.toml`.

## Architecture: Codex backend runs IN WSL

The Codex Desktop GUI (Windows, `AppData/Local/OpenAI/Codex`) runs its **backend inside WSL**, connecting via SSH to `localhost:2222` (`wsl-user-sshd` systemd --user service). Driven by `config.toml [desktop] runCodexInWindowsSubsystemForLinux = true`. It therefore needs a **Linux** `codex` binary, not the Windows `.exe`.

## Recurring issue: GUI won't open after a Windows Codex update

**Symptoms:** GUI window never appears (Task Manager may show it "running"), or error *"Unable to locate the Codex CLI binary / Set CODEX_CLI_PATH"*, or `code=126 Permission denied` (when CODEX_CLI_PATH wrongly points at the Windows `.exe` — can't exec a PE from WSL bash). First fixed 2026-06-16; recurred 2026-06-19 after update to GUI `26.616`.

**4 fixes — 3 are WSL-side and PERSIST across updates; only #3 gets wiped:**
1. **Linux shim** `/home/bkat3/.local/bin/codex` → `#!/bin/sh\nexec /home/bkat3/.nvm/versions/node/vXX/bin/codex "$@"`. Version-proof (transparently followed nvm 0.139→0.141).
2. **sshd SetEnv** in `~/.config/wsl-user-sshd/sshd_config`: `SetEnv PATH=/home/bkat3/.local/bin:/home/bkat3/.nvm/.../bin:...` then restart `wsl-user-sshd`. Makes non-login SSH shells resolve `codex` (they don't source `.bashrc`/nvm).
3. **Windows env var (THE piece updates wipe):** PowerShell `setx CODEX_CLI_PATH "/home/bkat3/.local/bin/codex"` — a **Linux path, NOT the .exe** — then fully quit + relaunch GUI from Start menu. (Now also pinned in `config.toml [mcp_servers.node_repl.env] CODEX_CLI_PATH` + `WSLENV` passthrough, which should make it more self-healing.)
4. If a stale `app-server` squats the control socket: `pkill -f 'codex app-server'`, `rm ~/.codex/app-server-control/{desktop-ssh-websocket-v0.sock,app-server-startup.lock}`.

**Triage on recurrence:** verify WSL side first — `~/.local/bin/codex --version`, `grep SetEnv ~/.config/wsl-user-sshd/sshd_config`, `ssh -p2222 localhost 'command -v codex'`. If all green, the fix is just re-running #3. Success signal: `~/AppData/Local/OpenAI/Codex/chrome-native-hosts-v2.json` regenerates after launch.

## MCP architecture: Docker Gateway vs Agent Systems Hub (NOT the same)

Two distinct layers — commonly confused:
- **Docker MCP Gateway** = a RUNNING program in Docker Desktop (Windows). Actually serves MCP tools to Codex. 315-server catalog + named profiles. Codex `[mcp_servers.MCP_DOCKER]` → `docker.exe mcp gateway run --profile tf_core_dev`. `tf_core_dev` bundles **github (26 tools) + filesystem (11 tools)** + dynamic-tools (`mcp-find`/`mcp-add`/`code-mode`/`mcp-exec`) for on-demand activation of any catalog server mid-session = the "max toolbox, minimal tool-belt" model. Docker profiles: ai_coding, tf_core_dev, tf_browser_research, tf_docs_knowledge, tf_business_ops, tf_commerce_payments, tf_infra_devops, tf_local_native.
- **Agent Systems Hub** (`~/.config/tangent-forge/agent-systems-hub/`) = markdown+YAML DOCS only, runs nothing. GOVERNS the gateway: `standards/AUTHENTICATED-ACCESS-MAP.md` mandates "one Docker Desktop MCP gateway binding per app, not N separate MCP servers." Does NOT replace/host the gateway. (GBrain at Mac `:3131` via Tailscale is the one thing actually centralized to the hub host — separate concern.)

**Codex plugins vs MCP:** Plugins `enabled=false` = INVISIBLE to the agent (no lazy load, unlike Claude Code's ToolSearch). Most curated plugins are remote OpenAI-hosted connectors (cheap when idle = context bloat only). Real local-process latency/hang sources are `[mcp_servers.*]` (npx/docker/powershell) and `model_reasoning_effort`.

## 2026-06-19 consolidation (config.toml, backup `.bak-perf-20260619`)

Was slow / intermittently timing out. Root causes + fixes (zero capability loss):
- `model_reasoning_effort`: `high → medium` (global). Biggest everyday-responsiveness win.
- Added `request_max_retries=4`, `stream_max_retries=5`, `stream_idle_timeout_ms=300000` — graceful retry vs. hard-timeout hangs.
- Disabled duplicate `mcp_gateway` (cmd.exe→docker WSL cross-call — a hang source).
- **Fixed gateway filesystem** (was EOF-crashing, `filesystem.paths` unset): `docker.exe mcp profile config tf_core_dev --set 'filesystem.paths=["C:\\Users\\bkat3","D:\\Projects","D:\\MCP_Central","D:\\knowledge\\TF Brain"]'` → 11 tools. **This fix persists in Docker's profile config, NOT config.toml** (survives Codex rewriting its own file).
- Disabled duplicate npx `github` (gateway serves it — hub-policy compliant).
- **Kept npx `filesystem` as a deliberate exception:** the Docker gateway filesystem can only volume-mount **Windows drives (C:/D:)**, NOT WSL-native `/home/bkat3/linux-projects` (primary workspace). This npx server is the only one serving WSL `/home/*`.

**Active MCP after:** MCP_DOCKER (gateway), filesystem (npx, WSL exception), context7, gbrain, node_repl. Disabled: github, mcp_gateway (dupes), browser, figma, firecrawl. Takes effect on Codex restart.

**Open lever:** `node_repl` `startup_timeout_sec = 120` can stall launches up to 2 min; lower to ~30s for fail-fast if slow startups persist.

## Topology note
TF-007/WSL is canonical runtime + dev home. GBrain canonical at `http://127.0.0.1:3131/mcp` (Mac-hub local); from WSL reached over Tailscale `http://tangents-macbook-pro.tail4fdc2e.ts.net:3131/mcp` via mcp-remote proxy.
