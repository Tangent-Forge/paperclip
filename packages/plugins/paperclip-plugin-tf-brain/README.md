# @paperclipai/plugin-tf-brain

Tangent Forge **Brain Operator Dashboard** — read-only visibility into
[gbrain](https://github.com/garrytan/gbrain) from inside Paperclip.

## v0 scope (this scaffold)

- **Overview tab** — high-level metrics: pages, chunks, sources, embed coverage,
  brain health score, orphans, stale pages, recent syncs.
- **Sources tab** — list of indexed gbrain sources with counts and freshness.
- **Search tab** — semantic query input + result snippets with source links.
- **Audit tab** — `gbrain doctor` health-check output.

The v0 plugin is strictly **read-only**: no `put_page`, no `import`, no
mutation of gbrain or of the Obsidian vault. All write paths stay manual /
human-gated per the global ingestion policy.

## Deferred to v0.1+

- Actions on the Orphans view (assign source, archive, link).
- Daily Briefing surface (cron-driven summary of new/changed pages).
- Graph visualization of page links and chunks.

## Data sources

- gbrain MCP HTTP endpoint at `http://127.0.0.1:3131/mcp` (per `CLAUDE.md`
  gbrain config). Auth via bearer token resolved through Paperclip secret
  references.
- Obsidian vault filesystem (read-only) at the canonical paths in
  `~/.config/tangent-forge/agent-systems-hub/BRAIN_MAP.md`.

## Enabling the plugin

TBD: registration steps after Phase 1 merge. The orchestrator wires
`pnpm-workspace.yaml`, runs `pnpm install` once, and installs the plugin into
the local Paperclip instance via the standard plugin install flow.

## Related

- Plan: `~/.claude/plans/agile-inventing-storm.md` (Phase 5).
- Reference plugin: `packages/plugins/examples/plugin-kitchen-sink-example/`.
