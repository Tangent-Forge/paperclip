import { describe, expect, it } from "vitest";
import {
  parseSecretRefBinding,
  validateAnthropicModel,
  validateGithubPullRequestNumber,
  validateGithubRepo,
  validateHealthCheckUrl,
} from "../src/config-validation.js";

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
  it("rejects loopback when it is not explicitly allowlisted", () => {
    expect(validateHealthCheckUrl("http://127.0.0.1:3100/api/health")).toBeNull();
    expect(validateHealthCheckUrl("http://localhost:3100/api/health")).toBeNull();
    expect(validateHealthCheckUrl("http://[::1]:3100/api/health")).toBeNull();
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

  it("requires an exact hostname allowlist match", () => {
    expect(validateHealthCheckUrl("https://paperclip.example.com/api/health", ["example.com"])).toBeNull();
    expect(validateHealthCheckUrl("https://paperclip.example.com/api/health", ["PAPERCLIP.EXAMPLE.COM"]))
      .toBe("https://paperclip.example.com/api/health");
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

  it("rejects credentials, query/fragment data, and any path other than the approved health endpoint", () => {
    expect(validateHealthCheckUrl("http://user:pass@127.0.0.1:3100/api/health")).toBeNull();
    expect(validateHealthCheckUrl("http://127.0.0.1:3100/api/health?target=/admin")).toBeNull();
    expect(validateHealthCheckUrl("http://127.0.0.1:3100/api/health#fragment")).toBeNull();
    expect(validateHealthCheckUrl("http://127.0.0.1:3100/api/plugins")).toBeNull();
    expect(validateHealthCheckUrl("http://127.0.0.1:3100/latest/meta-data")).toBeNull();
  });
});

describe("validateAnthropicModel", () => {
  it("accepts bounded Claude model ids", () => {
    expect(validateAnthropicModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(validateAnthropicModel(" claude-3-7-sonnet-20250219 ")).toBe("claude-3-7-sonnet-20250219");
  });

  it("rejects non-Claude, path-like, whitespace-bearing, and non-string ids", () => {
    expect(validateAnthropicModel("gpt-5")).toBeNull();
    expect(validateAnthropicModel("claude-../admin")).toBeNull();
    expect(validateAnthropicModel("claude-sonnet 5")).toBeNull();
    expect(validateAnthropicModel(null)).toBeNull();
  });
});

describe("validateGithubPullRequestNumber", () => {
  it("accepts positive safe integers and rejects every other shape", () => {
    expect(validateGithubPullRequestNumber(109)).toBe(109);
    expect(validateGithubPullRequestNumber(0)).toBeNull();
    expect(validateGithubPullRequestNumber(-1)).toBeNull();
    expect(validateGithubPullRequestNumber(1.5)).toBeNull();
    expect(validateGithubPullRequestNumber("109")).toBeNull();
  });
});

describe("parseSecretRefBinding", () => {
  // config.<x>SecretRef arrives from ctx.config.get() as the host's resolved
  // { type: "secret_ref", secretId, version? } binding object — the manifest's
  // `type: "string"` only describes what a secret picker POSTs, not what the
  // worker reads back. See companion-service.ts's comments at both call sites.
  it("accepts a well-formed binding object with no version (defaults to latest at resolve time)", () => {
    expect(parseSecretRefBinding({ type: "secret_ref", secretId: "abc-123" })).toEqual({
      type: "secret_ref",
      secretId: "abc-123",
    });
  });

  it("accepts an explicit \"latest\" or numeric version", () => {
    expect(parseSecretRefBinding({ type: "secret_ref", secretId: "abc-123", version: "latest" })).toEqual({
      type: "secret_ref",
      secretId: "abc-123",
      version: "latest",
    });
    expect(parseSecretRefBinding({ type: "secret_ref", secretId: "abc-123", version: 3 })).toEqual({
      type: "secret_ref",
      secretId: "abc-123",
      version: 3,
    });
  });

  it("rejects a raw string — the deliberately unsupported legacy shape that the real host fails closed on", () => {
    expect(parseSecretRefBinding("abc-123")).toBeNull();
    expect(parseSecretRefBinding("")).toBeNull();
  });

  it("rejects malformed or wrong-shape objects", () => {
    expect(parseSecretRefBinding(null)).toBeNull();
    expect(parseSecretRefBinding(undefined)).toBeNull();
    expect(parseSecretRefBinding([])).toBeNull();
    expect(parseSecretRefBinding({})).toBeNull();
    expect(parseSecretRefBinding({ type: "plain", value: "x" })).toBeNull();
    expect(parseSecretRefBinding({ type: "secret_ref" })).toBeNull(); // missing secretId
    expect(parseSecretRefBinding({ type: "secret_ref", secretId: "" })).toBeNull();
    expect(parseSecretRefBinding({ type: "secret_ref", secretId: "abc", version: 0 })).toBeNull();
    expect(parseSecretRefBinding({ type: "secret_ref", secretId: "abc", version: -1 })).toBeNull();
    expect(parseSecretRefBinding({ type: "secret_ref", secretId: "abc", version: "not-latest" })).toBeNull();
  });
});
