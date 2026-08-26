---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

Paperclip supports two runtime modes with different security profiles. Reachability is configured separately with `bind`.

## `local_trusted`

The default mode. Optimized for CLI/agent-only local use — **not** for
ongoing human use of the Board UI in a browser (see below).

- **Host binding**: loopback only (localhost)
- **Bind**: `loopback`
- **Authentication**: no login required
- **Use case**: local development, solo experimentation, agent automation
  with no human browsing the Board UI
- **Board identity (CLI/agents)**: board API keys, agent API keys, and agent
  JWTs all work normally, unaffected by this mode
- **Board identity (browser UI)**: **none.** As of PAP-1975, `local_trusted`
  no longer grants any implicit board identity to unauthenticated loopback
  requests (any other process on the same host could otherwise reach the
  same port and get the same authority as the operator). The Board UI only
  ever sends cookies, never a bearer token, and this mode has no session
  mechanism by design (see "Board Claim Flow" below and
  `doc/plans/2026-08-25-local-trusted-board-access-gap.md`) — so every
  board-gated page returns 403. If you need to use the Board UI as a human,
  use `authenticated` + `private` instead.

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

Login required. Supports two exposure policies.

### `authenticated` + `private`

For private network access (Tailscale, VPN, LAN).

- **Authentication**: login required via Better Auth
- **URL handling**: auto base URL mode (lower friction)
- **Host trust**: private-host trust policy required
- **Bind**: choose `loopback`, `lan`, `tailnet`, or `custom`

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

Allow custom Tailscale hostnames:

```sh
npx paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

For internet-facing deployment.

- **Authentication**: login required
- **URL**: explicit public URL required
- **Security**: stricter deployment checks in doctor
- **Bind**: usually `loopback` behind a reverse proxy; `lan/custom` is advanced

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## Board Claim Flow

When migrating from `local_trusted` to `authenticated`, Paperclip emits a one-time claim URL at startup:

```
/board-claim/<token>?code=<code>
```

A signed-in user visits this URL to claim board ownership. This:

- Promotes the current user to instance admin
- Demotes the auto-created local board admin
- Ensures active company membership for the claiming user

## Changing Modes

Update the deployment mode:

```sh
pnpm paperclipai configure --section server
```

Runtime override via environment variable:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=lan pnpm paperclipai run
```
