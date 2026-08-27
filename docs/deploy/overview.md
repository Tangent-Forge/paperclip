---
title: Deployment Overview
summary: Deployment modes at a glance
---

Paperclip supports three deployment configurations, from zero-friction local to internet-facing production.

## Deployment Modes

| Mode | Auth | Best For |
|------|------|----------|
| `local_trusted` | No login required | CLI/agent-only local use — **no working Board UI sign-in**, see below |
| `authenticated` + `private` | Login required | Private network (Tailscale, VPN, LAN) — including solo human use of the Board UI |
| `authenticated` + `public` | Login required | Internet-facing cloud deployment |

## Quick Comparison

### Local Trusted (Default)

- Loopback-only host binding (localhost)
- No human login flow — and therefore **no working Board UI sign-in**: every
  board-gated page 403s (see [deployment-modes.md](deployment-modes.md#local_trusted))
- Fastest local startup
- Best for: CLI/agent automation with no human browsing the Board UI

### Authenticated + Private

- Login required via Better Auth
- Binds to all interfaces for network access
- Auto base URL mode (lower friction)
- Best for: team access over Tailscale or local network

### Authenticated + Public

- Login required
- Explicit public URL required
- Stricter security checks
- Best for: cloud hosting, internet-facing deployment

## Choosing a Mode

- **Just trying Paperclip's CLI/agents, no browser Board UI needed?** Use `local_trusted` (the default)
- **Want to use the Board UI at all, even solo?** Use `authenticated` + `private` — `local_trusted` cannot sign you in
- **Sharing with a team on private network?** Use `authenticated` + `private`
- **Deploying to the cloud?** Use `authenticated` + `public` — see [AWS ECS Fargate guide](aws-ecs.md)

Set the mode during onboarding:

```sh
pnpm paperclipai onboard
```

Or update it later:

```sh
pnpm paperclipai configure --section server
```
