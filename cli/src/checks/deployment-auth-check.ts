import { inferBindModeFromHost } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

export function deploymentAuthCheck(config: PaperclipConfig): CheckResult {
  const mode = config.server.deploymentMode;
  const exposure = config.server.exposure;
  const auth = config.auth;
  const bind = config.server.bind ?? inferBindModeFromHost(config.server.host);

  if (mode === "local_trusted") {
    if (bind !== "loopback") {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: `local_trusted requires loopback binding (found ${bind})`,
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and choose Local trusted / loopback reachability",
      };
    }
    // PAP-1975 removed local_trusted's implicit board grant for
    // unauthenticated loopback requests (any shell-capable agent on the
    // host could otherwise reach the same port and get the same authority
    // as the human operator). No session mechanism replaced it — by design,
    // local_trusted stays "no login required" — so the real Board UI (which
    // only ever sends cookies, never a bearer token) now has no working
    // identity path in this mode; see doc/plans/2026-08-25-local-trusted-board-access-gap.md.
    // CLI/agent credential paths (board API keys, agent API keys, agent
    // JWTs) are unaffected. Warn, don't fail: local_trusted with no
    // interactive human Board UI use (pure agent automation) is still a
    // legitimate, fully working configuration.
    return {
      name: "Deployment/auth mode",
      status: "warn",
      message:
        "local_trusted mode is configured for loopback-only access, but its Board UI has no working " +
        "sign-in — any board-gated web UI action returns 403 (PAP-1975 removed the implicit grant, " +
        "and local_trusted has no session mechanism by design)",
      canRepair: false,
      repairHint:
        "If you use the Board UI as a human, switch to `authenticated` + `private` " +
        "(`paperclipai configure --section server`) for real sign-in over Tailscale/VPN/LAN. " +
        "CLI and agent credentials are unaffected either way.",
    };
  }

  const secret =
    process.env.BETTER_AUTH_SECRET?.trim() ??
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (!secret) {
    return {
      name: "Deployment/auth mode",
      status: "fail",
      message: "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET)",
      canRepair: false,
      repairHint: "Set BETTER_AUTH_SECRET before starting Paperclip",
    };
  }

  if (auth.baseUrlMode === "explicit" && !auth.publicBaseUrl) {
    return {
      name: "Deployment/auth mode",
      status: "fail",
      message: "auth.baseUrlMode=explicit requires auth.publicBaseUrl",
      canRepair: false,
      repairHint: "Run `paperclipai configure --section server` and provide a base URL",
    };
  }

  if (exposure === "public") {
    if (auth.baseUrlMode !== "explicit" || !auth.publicBaseUrl) {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: "authenticated/public requires explicit auth.publicBaseUrl",
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and select public exposure",
      };
    }
    try {
      const url = new URL(auth.publicBaseUrl);
      if (url.protocol !== "https:") {
        return {
          name: "Deployment/auth mode",
          status: "warn",
          message: "Public exposure should use an https:// auth.publicBaseUrl",
          canRepair: false,
          repairHint: "Use HTTPS in production for secure session cookies",
        };
      }
    } catch {
      return {
        name: "Deployment/auth mode",
        status: "fail",
        message: "auth.publicBaseUrl is not a valid URL",
        canRepair: false,
        repairHint: "Run `paperclipai configure --section server` and provide a valid URL",
      };
    }
  }

  return {
    name: "Deployment/auth mode",
    status: "pass",
    message: `Mode ${mode}/${exposure} with bind ${bind} and auth URL mode ${auth.baseUrlMode}`,
  };
}
