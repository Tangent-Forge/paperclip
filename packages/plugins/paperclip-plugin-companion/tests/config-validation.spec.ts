import { describe, expect, it } from "vitest";
import { validateGithubRepo, validateHealthCheckUrl } from "../src/config-validation.js";

describe("validateGithubRepo", () => {
  it("accepts a well-formed owner/repo", () => {
    expect(validateGithubRepo("Tangent-Forge/paperclip")).toBe("Tangent-Forge/paperclip");
    expect(validateGithubRepo("  Tangent-Forge/paperclip  ")).toBe("Tangent-Forge/paperclip");
    expect(validateGithubRepo("a.b-c_d/e.f-g_h")).toBe("a.b-c_d/e.f-g_h");
  });

  it("rejects values with no slash, extra slashes, or path traversal", () => {
    expect(validateGithubRepo("just-a-name")).toBeNull();
    expect(validateGithubRepo("owner/repo/extra")).toBeNull();
    expect(validateGithubRepo("owner/../repo")).toBeNull();
    expect(validateGithubRepo("../owner/repo")).toBeNull();
  });

  it("rejects query-string / fragment / whitespace injection attempts", () => {
    expect(validateGithubRepo("owner/repo?x=1")).toBeNull();
    expect(validateGithubRepo("owner/repo#frag")).toBeNull();
    expect(validateGithubRepo("owner/repo commits/master")).toBeNull();
    expect(validateGithubRepo("owner/repo\ncommits/master")).toBeNull();
  });

  it("rejects an empty owner or repo segment", () => {
    expect(validateGithubRepo("/repo")).toBeNull();
    expect(validateGithubRepo("owner/")).toBeNull();
    expect(validateGithubRepo("/")).toBeNull();
    expect(validateGithubRepo("")).toBeNull();
  });
});

describe("validateHealthCheckUrl", () => {
  it("accepts the shipped default loopback URL with no allowlist needed", () => {
    expect(validateHealthCheckUrl("http://127.0.0.1:3100/api/health")).toBe("http://127.0.0.1:3100/api/health");
  });

  it("accepts localhost and IPv6 loopback by default", () => {
    expect(validateHealthCheckUrl("http://localhost:3100/api/health")).not.toBeNull();
    expect(validateHealthCheckUrl("http://[::1]:3100/api/health")).not.toBeNull();
  });

  it("rejects a non-loopback host with no allowlist entry", () => {
    expect(validateHealthCheckUrl("http://evil.example.com/api/health")).toBeNull();
    expect(validateHealthCheckUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
  });

  it("accepts a non-loopback host once explicitly allowlisted", () => {
    expect(validateHealthCheckUrl("https://staging.internal.example.com/api/health", ["staging.internal.example.com"])).toBe(
      "https://staging.internal.example.com/api/health",
    );
  });

  it("rejects non-http(s) schemes even against an allowlisted host", () => {
    expect(validateHealthCheckUrl("file:///etc/passwd")).toBeNull();
    expect(validateHealthCheckUrl("javascript:alert(1)")).toBeNull();
    expect(validateHealthCheckUrl("ftp://127.0.0.1/x")).toBeNull();
  });

  it("rejects malformed URLs and empty values", () => {
    expect(validateHealthCheckUrl("not a url")).toBeNull();
    expect(validateHealthCheckUrl("")).toBeNull();
  });
});
