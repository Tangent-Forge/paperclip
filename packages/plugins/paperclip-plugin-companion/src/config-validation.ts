// Validation for operator-configured outbound-reaching plugin config values
// (`githubRepo`, `healthCheckUrl`). Both are interpolated into outbound HTTP
// requests, so an unvalidated value is a URL/path-injection surface even
// though the values are operator-set plugin config, not end-user input.
//
// Both functions are pure and return `null` on anything invalid — callers
// must treat `null` as "refuse to use this value" (report a distinct
// "not configured" / "invalid" evidence state), never fall back to guessing
// or silently using the raw unvalidated input.

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

// Hosts a `healthCheckUrl` may point at without any explicit operator
// allowlist. Loopback only — matches the shipped default
// (http://127.0.0.1:3100/api/health) and nothing else, so an operator who
// wants a non-loopback deployment health endpoint must opt in explicitly via
// `healthCheckHostAllowlist`.
const DEFAULT_ALLOWED_HEALTH_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Validate a `healthCheckUrl` config value: must parse as an absolute
 * http(s) URL whose hostname is loopback or on the operator-supplied
 * allowlist. Returns the normalized URL string if valid, otherwise `null`.
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
  const allowed = new Set(DEFAULT_ALLOWED_HEALTH_HOSTS);
  for (const host of extraAllowedHosts) {
    if (typeof host === "string" && host.trim()) allowed.add(host.trim().toLowerCase());
  }
  // URL#hostname keeps the bracket wrapper for IPv6 literals (e.g. "[::1]");
  // strip it so "::1" in the allowlist matches as expected.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!allowed.has(hostname)) return null;
  return parsed.toString();
}
