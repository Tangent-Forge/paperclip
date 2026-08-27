// Validation for operator-configured outbound-reaching plugin config values
// (`githubRepo`, `healthCheckUrl`) and secret-ref config bindings
// (`anthropicApiKeySecretRef`, `githubTokenSecretRef`). All are interpolated
// into outbound HTTP requests or passed to `ctx.secrets.resolve()`, so an
// unvalidated value is an injection/misuse surface even though these are
// operator-set plugin config, not end-user input.
//
// All functions here are pure and return `null` on anything invalid —
// callers must treat `null` as "refuse to use this value" (report a distinct
// "not configured" / "invalid" evidence state), never fall back to guessing
// or silently using the raw unvalidated input.
import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

// `format: "secret-ref"` config fields are declared `type: "string"` in the
// manifest (the shape a secret-picker submits, and the only shape AJV's
// no-op "secret-ref" format check enforces via that declared type) — but the
// host resolves/serves the STORED value back to the worker as the full
// `{ type: "secret_ref", secretId, version? }` binding object, and
// `ctx.secrets.resolve()` throws on a raw string (deliberately: "legacy
// string UUID references fail closed", per PluginSecretsClient.resolve()'s
// own contract). Every plugin's worker must read these config fields as
// binding objects, not strings — mirrors paperclip-plugin-linear-sync's own
// `readConfig()` secretRef() helper, which does the same parse for the same
// reason.
export function parseSecretRefBinding(value: unknown): EnvSecretRefBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref") return null;
  const secretId = typeof record.secretId === "string" ? record.secretId.trim() : "";
  if (!secretId) return null;
  const version = record.version;
  if (version === undefined || version === null) return { type: "secret_ref", secretId };
  if (version === "latest") return { type: "secret_ref", secretId, version: "latest" };
  if (typeof version === "number" && Number.isInteger(version) && version > 0) {
    return { type: "secret_ref", secretId, version };
  }
  return null;
}

// GitHub owner/repo names: alphanumeric plus `.`, `_`, `-`; no leading/trailing
// separator; exactly one `/`. Mirrors GitHub's own naming rules closely enough
// to reject path-traversal (`../`), query/fragment injection (`?`, `#`),
// and extra path segments — without needing to know GitHub's full grammar.
const OWNER_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Validate a `githubRepo` config value as a strict `owner/repo` string.
 * Returns the trimmed value if valid, otherwise `null`.
 */
export function validateGithubRepo(value: string): string | null {
  const trimmed = value.trim();
  if (!OWNER_REPO_PATTERN.test(trimmed)) return null;
  if (trimmed.includes("..") || trimmed.includes("//")) return null;
  return trimmed;
}

/**
 * Validate a `healthCheckUrl` config value: must parse as an absolute
 * http(s) URL whose hostname is on the operator-supplied allowlist. The host
 * HTTP client independently blocks private/reserved targets, including
 * loopback, so this plugin deliberately has no implicit localhost exception.
 * Returns the normalized URL string if valid, otherwise `null`.
 */
export function validateHealthCheckUrl(value: string, extraAllowedHosts: string[] = []): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // This setting is a health-endpoint selector, not a general-purpose URL.
  // Constraining the path and forbidding credentials/query/fragment prevents
  // an allowlisted host (especially loopback) from becoming an SSRF tunnel to
  // arbitrary application/admin endpoints on that host.
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/api/health") return null;
  const allowed = new Set<string>();
  for (const host of extraAllowedHosts) {
    if (typeof host === "string" && host.trim()) allowed.add(host.trim().toLowerCase());
  }
  // URL#hostname keeps the bracket wrapper for IPv6 literals (e.g. "[::1]");
  // strip it so "::1" in the allowlist matches as expected.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!allowed.has(hostname)) return null;
  return parsed.toString();
}

const ANTHROPIC_MODEL_PATTERN = /^claude-[a-z0-9][a-z0-9._-]{0,119}$/;

/**
 * Validate the direct-provider model id. Companion intentionally supports
 * Anthropic Claude models only in this MVP; rejecting whitespace, URL/path
 * syntax, and non-Claude ids keeps the provider contract explicit.
 */
export function validateAnthropicModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ANTHROPIC_MODEL_PATTERN.test(trimmed) ? trimmed : null;
}

/** Validate an optional configured GitHub pull-request number. */
export function validateGithubPullRequestNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
