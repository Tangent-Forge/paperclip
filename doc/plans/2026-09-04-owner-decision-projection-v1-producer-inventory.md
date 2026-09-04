# Owner Decision Projection v1 — Producer Inventory + Warn-First Canary

UTC: 2026-09-04
Branch: feat/owner-decision-projection-v1
Enforce default: warn (`PAPERCLIP_OWNER_GUIDANCE_ENFORCE`)
Regression guard: `pnpm check:owner-guidance-producers` / `node scripts/check-owner-guidance-producers.mjs`

## First-party producers identified

| Producer | Path | Update status |
| --- | --- | --- |
| Shared schema | `packages/shared` ownerGuidance + evaluateOwnerGuidanceOnCreate | Updated |
| Server create path | `server/src/services/issue-thread-interactions.ts` | Updated (warn log / strict 422) |
| MCP tools | `packages/mcp-server` uses shared payload schemas | Inherits ownerGuidance; docs require for human |
| Skills runtime | `skills/paperclip/SKILL.md` + `references/api-reference.md` | Updated (guided examples + anti-escalation) |
| Skills release roster | `skills-releases/paperclip/v7-roster/**` | Updated |
| Onboarding AGENTS templates | `server/src/onboarding-assets/**/AGENTS.md` + CEO HEARTBEAT | Updated |
| Reflection coach | `server/src/built-ins/agents/reflection-coach/**` + catalog skill | Updated |
| Skills catalog ops | issue-triage, task-planning, prepare-mcp-integration | Updated |
| Agent-developer guides | `docs/guides/agent-developer/**` | Updated |
| API docs | `docs/api/issues.md` | Updated |
| CLI docs | `doc/CLI.md` | Updated guided example |
| OpenClaw adapter prompt | `packages/adapters/openclaw-gateway/src/server/execute.ts` | Updated |
| UI fixtures | `ui/src/fixtures/issueThreadInteractionFixtures.ts` | Guided + legacy bare fixtures |
| Historical skill release | `skills-releases/paperclip/v0/**` | Intentionally legacy/read-only (allowlisted in regression guard; not a live producer) |

## Regression guard

- Script: `scripts/check-owner-guidance-producers.mjs`
- Unit tests: `scripts/check-owner-guidance-producers.test.mjs`
- npm: `pnpm check:owner-guidance-producers`, `pnpm test:check-owner-guidance-producers`
- Fails if first-party templates teach bare human confirmation creates or omit ownerGuidance contract fields

## Canary rules

- Grandfathered existing bare cards: readable/answerable (F6)
- New bare creates: logged as `owner_guidance.create.producer_defect` with code/kind/issue/actor
- No silent server-side guidance synthesis
- Unknown producer failures surface explicitly in logs (and 422 under strict)

## Strict enable recommendation

After residual first-party producer templates were updated and the regression guard is green:

**ENABLE STRICT is recommended for CI/test and for production once this PR is merged and deployed under separate authorization.**

Default env remains warn until operators flip `PAPERCLIP_OWNER_GUIDANCE_ENFORCE=strict` after merge/deploy authorization. This PR does not enable production strict by itself.
