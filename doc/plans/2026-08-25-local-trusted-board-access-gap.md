# local_trusted Board Access Gap (post-PAP-1975)

Status: Accepted (direction B)
Owner: Server
Date: 2026-08-25
Related: PAP-1975, doc/plans/2026-02-23-deployment-auth-mode-consolidation.md, docs/deploy/deployment-modes.md

## Problem

PAP-1975 (`server/src/middleware/auth.ts`) correctly removed `local_trusted`
mode's implicit board/instance-admin grant for any unauthenticated loopback
request — any shell-capable agent on the same host could reach the same
loopback port and get the same authority as the human operator, which was an
unconditional privilege escalation, not a convenience.

The fix left a real gap: `local_trusted` mode never wires up Better Auth
(`server/src/index.ts`, `if (config.deploymentMode === "authenticated")`
gates session issuance/resolution entirely), and the real Board UI
(`ui/src/api/client.ts`) sends cookies only, never a bearer token. So after
this fix, a human using the Board UI in `local_trusted` mode gets `type:
"none"` on every request — the same as an unauthenticated agent — and every
board-gated route (`assertBoard`, `assertAuthenticated`, etc.) 403/401s.

## Two candidate directions

**(A) Give `local_trusted` mode real sessions too** — widen the
`authenticated`-only gates so Better Auth also runs in `local_trusted` mode.
Rejected: `local_trusted` is documented (`docs/deploy/deployment-modes.md`)
as "no login required" by design, for genuinely single-operator local use.
Adding a login flow to a mode whose entire point is "no login" both
contradicts its documented contract and re-expands the app's auth surface
in the one mode meant to have the smallest possible surface.

**(B) `local_trusted` stays exactly as PAP-1975 left it** — no implicit
grant, no session path, matching its documented "no login" design. A human
who needs a durable, per-actor Board identity has already-built, fully
supported path available: switch the instance to `authenticated` + `private`
(Tailscale/VPN/LAN, real Better Auth login/session, the existing
`board-claim.ts` challenge flow already handles the ownership handoff from
the synthetic `local-board` principal to a real signed-in user). This
requires **zero new runtime auth code** and doesn't touch the CLI/agent
credential paths (board API key / agent API key / agent JWT), which were
already correct and are the intended way for any non-operator caller
(agents, scripts, CI, e2e tests) to act on the board in either mode.

**Decision: (B).**

## What (B) requires, beyond PAP-1975's auth.ts change

1. **Actionable error messages** (`server/src/routes/authz.ts`,
   `unauthenticatedBoardAccessMessage`) — a board-access denial while
   `deploymentMode === "local_trusted"` now explains why (PAP-1975) and
   names the supported path (`authenticated` + `private`,
   `pnpm paperclipai configure --section server`) instead of a bare
   "Board access required".
2. **e2e/server test migration** — every test that exercises a board-gated
   route in `local_trusted` mode (the suite's own default mode) needs an
   explicit board credential, via the same pattern already established in
   `tests/e2e/fixtures/board-auth.ts` (browser tests) or a directly-minted
   board API key (server unit/integration tests) — never an implicit grant.
3. **A coverage check** so a new board-protected e2e spec can't silently
   land on plain `@playwright/test` (implicitly relying on a
   `local_trusted` grant that no longer exists) without CI catching it.

## Out of scope / follow-up

`req.actor.source === "local_implicit"` is referenced as an authorization
shortcut in ~34 call sites across the server (`routes/authz.ts`,
`routes/companies.ts`, `routes/secrets.ts`, `services/authorization.ts`,
etc.), but nothing has assigned that value since PAP-1975 removed its one
call site in `auth.ts` — confirmed via full-repo grep. These are dead,
permanently-unreachable branches, not a live gap (there's no way to trigger
them, so they fail closed, not open) — but they're latent tech debt PAP-1975
left behind and should eventually be deleted. Not blocking this PR; flagged
separately.
