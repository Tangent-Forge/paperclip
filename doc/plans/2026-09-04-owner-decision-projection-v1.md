# 2026-09-04 — Owner Decision Projection v1 (PAP-3225 / TAN-1015)

## Authority

- Design: accepted DESIGN.md (spec phase)
- Implement: authorized 2026-09-04 (PR open allowed; merge/deploy NOT authorized)
- Not in scope: PAP-2984/F-14, disposition batch reopen, broader inbox redesign

## Contract

- Additive `payload.ownerGuidance` on human interaction kinds
- Live create default: `PAPERCLIP_OWNER_GUIDANCE_ENFORCE=warn` (log producer defects; do not synthesize guidance)
- Strict mode: `PAPERCLIP_OWNER_GUIDANCE_ENFORCE=strict` → 422 on bare/incomplete human creates
- Human Decisions lane: pure filter via `classifyHumanDecisionsLane` / `filterHumanDecisionsBlockedRows`
- `owner_terminal`: parent dependency chip only; no fake Decide
- Disposition: variant `needs_disposition`, owner forced agent

## Sequence

1. Shared types + Zod + projection helpers + tests
2. Server create enforce (warn/strict) + attention projection
3. UI blockedInbox remap + guidance chrome
4. Skills/MCP docs producers
5. Fixture matrix F1–F8
6. Open PR — stop (no merge)

## Env

| Value | Behavior |
| --- | --- |
| unset / `warn` | Canary: create succeeds; log `owner_guidance.create.producer_defect` |
| `strict` / `on` / `1` / `true` | Reject bare human creates with 422 |
