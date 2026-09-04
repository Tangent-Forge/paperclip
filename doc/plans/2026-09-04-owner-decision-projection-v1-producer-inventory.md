# PAP-3225 Producer Inventory + Warn-First Canary

UTC: 2026-09-04
Branch: feat/owner-decision-projection-v1
Enforce default: warn (`PAPERCLIP_OWNER_GUIDANCE_ENFORCE`)

## First-party producers identified

| Producer | Path | Update status |
| --- | --- | --- |
| Shared schema | `packages/shared` ownerGuidance + evaluateOwnerGuidanceOnCreate | Updated |
| Server create path | `server/src/services/issue-thread-interactions.ts` | Updated (warn log / strict 422) |
| MCP tools | `packages/mcp-server` uses `requestConfirmationPayloadSchema` | Inherits optional ownerGuidance; docs note required for human |
| Skills runtime | `skills/paperclip/SKILL.md` + `references/api-reference.md` | Updated |
| Skills release roster | `skills-releases/paperclip/v7-roster/references/api-reference.md` | Updated |
| Onboarding AGENTS templates | `server/src/onboarding-assets/**/AGENTS.md` | Residual: still show bare example shapes — **producer defect until follow-up** (warn canary will log if used live) |
| Reflection coach AGENTS | `server/src/built-ins/agents/reflection-coach/**` | Residual: same |
| CLI docs | `doc/CLI.md` bare example | Residual docs-only |
| UI fixtures | `ui/src/fixtures/issueThreadInteractionFixtures.ts` | Default confirmation + hard_human + legacy bare fixtures |

## Canary rules

- Grandfathered existing bare cards: readable/answerable (F6)
- New bare creates: logged as `owner_guidance.create.producer_defect` with code/kind/issue/actor
- No silent server-side guidance synthesis
- Unknown producer failures surface explicitly in logs (and 422 under strict)

## Strict enable recommendation

See PR body after exact-head tests. Default recommendation until onboarding/built-in templates are fully converted: **DO NOT ENABLE STRICT** in production until residual template producers are updated or proven unused. Shared + server path + skills docs are ready for strict in test/CI.
