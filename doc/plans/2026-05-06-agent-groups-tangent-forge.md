# Agent Groups — Tangent Forge Tools Integration
Date: 2026-05-06

## Overview

Three agent groups sourced from TANGENT_FORGE tools, designed to run as Paperclip-managed agents.

---

## Group 1: Janitor

**Purpose:** Automated workspace hygiene — audit, storage cleanup, security scanning — using local models via LMO/Ollama. Zero cloud API cost for routine maintenance.

**Adapter:** `janitor_local` (`packages/adapters/janitor-local`)

### Agents

#### workspace-auditor

```yaml
name: Workspace Auditor
adapterType: janitor_local
config:
  cwd: /home/bkat3/linux-projects
  modules: [workspace, dev_tools]
  dryRun: true
  approvalRequired: true
  model: lmo:auto
  lmoUrl: http://127.0.0.1:8000
  timeoutSec: 180
```

**Trigger:** Weekly cron or on-demand via Paperclip issue.
**Output:** Markdown audit report in `.janitor/reports/`.

#### storage-cleaner

```yaml
name: Storage Cleaner
adapterType: janitor_local
config:
  cwd: /home/bkat3/linux-projects
  modules: [storage, performance]
  dryRun: true
  approvalRequired: true
  maxStorageAgeDays: 60
  model: ollama/llama3.2:3b
  timeoutSec: 300
```

**Trigger:** On-demand. dryRun=true until operator confirms report looks correct.
**Approval gate:** Required before any delete actions (enforced by adapter).

#### security-scanner

```yaml
name: Security Scanner
adapterType: janitor_local
config:
  cwd: /home/bkat3/linux-projects
  modules: [security]
  dryRun: true
  approvalRequired: true
  secretsPatterns:
    - "gumroad_[a-zA-Z0-9_]{10,}"
  model: ollama/qwen2.5-coder:7b
  timeoutSec: 120
```

**Trigger:** Pre-commit hook or weekly. Never auto-remediates without approval.

---

## Group 2: Content Pipeline

**Purpose:** AI-assisted short-form video script drafting, revision, and planning — preserving the Tangent Forge voice. Human recording checkpoint enforced before publish.

**Adapter:** Any cloud agent (e.g. `claude_local`) using the system prompts as skills/instructions files.

**Source prompts:** `TANGENT_FORGE/tools/no-ai-slop-content-system/prompts/`

### Agents

#### script-drafter

```yaml
name: Script Drafter
adapterType: claude_local
config:
  model: claude-haiku-4-6
  instructionsFilePath: /home/bkat3/linux-projects/TANGENT_FORGE/tools/no-ai-slop-content-system/prompts/script_generation.system.md
  maxTurnsPerRun: 5
  dangerouslySkipPermissions: true
```

**Trigger:** Issue created with title "Draft script: [topic]".
**Output:** Script file in TANGENT_FORGE queue with `recording_status: draft`.
**Approval gate:** Human review required before `recording_status` advances to `approved`.

#### script-reviewer

```yaml
name: Script Reviewer
adapterType: claude_local
config:
  model: claude-haiku-4-6
  instructionsFilePath: /home/bkat3/linux-projects/TANGENT_FORGE/tools/no-ai-slop-content-system/prompts/script_revision.system.md
  maxTurnsPerRun: 3
  dangerouslySkipPermissions: true
```

**Trigger:** Script moves to `review` queue.
**Output:** Revised script with voice checklist applied.

#### content-planner

```yaml
name: Content Planner
adapterType: claude_local
config:
  model: claude-haiku-4-6
  instructionsFilePath: /home/bkat3/linux-projects/TANGENT_FORGE/tools/no-ai-slop-content-system/prompts/weekly_planning.system.md
  maxTurnsPerRun: 3
  dangerouslySkipPermissions: true
```

**Trigger:** Monday cron — generates a weekly content plan issue.

---

## Group 3: Ops (Gumroad)

**Purpose:** Product and sales operations automation for Tangent Forge Gumroad store. Agents can query sales, generate offer codes, and verify licenses. Write operations require approval.

**MCP Server:** `packages/mcp-server-gumroad` — exposes 6 tools via stdio transport.

**Configuration in agent's MCP config:**

```json
{
  "mcpServers": {
    "gumroad": {
      "command": "node",
      "args": ["/path/to/paperclip/packages/mcp-server-gumroad/dist/stdio.js"],
      "env": {
        "GUMROAD_ACCESS_TOKEN": "${GUMROAD_ACCESS_TOKEN}"
      }
    }
  }
}
```

### Agents

#### gumroad-ops

```yaml
name: Gumroad Ops
adapterType: claude_local
config:
  model: claude-haiku-4-6
  maxTurnsPerRun: 10
  dangerouslySkipPermissions: true
  env:
    GUMROAD_ACCESS_TOKEN: "${GUMROAD_ACCESS_TOKEN}"
```

**Available MCP tools:**
- `gumroad_list_products` — list all products
- `gumroad_get_sales_summary` — sales breakdown by period
- `gumroad_list_offer_codes` — list codes for a product
- `gumroad_create_offer_code` — **requires approval gate**
- `gumroad_delete_offer_code` — **requires approval gate**
- `gumroad_verify_license` — customer support automation
- `gumroad_export_sales_csv` — export sale records

**Trigger:** On-demand issues ("Generate launch codes for product X", "Show me last 7 days sales").

---

## Wiring Notes

1. **`pnpm install`** — run from paperclip root after these packages are added.
2. **Janitor adapter registration** — wire `janitor_local` into `server/src/adapters/registry.ts` following the `feat/external-adapter-phase1` pattern (or register via `~/.paperclip/adapter-plugins.json` for local dev).
3. **Gumroad MCP server** — add `GUMROAD_ACCESS_TOKEN` to the agent's env in Paperclip board. Token is in TANGENT_FORGE `.env` (do not commit).
4. **Content group** — system prompt files already exist and are ready to reference. No porting needed.
5. **LMO** — start `tangent-forge-lmo` before running janitor agents with `model: lmo:auto`.
