import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealGitClient, RealGitHubClient } from "../services/delivery-publisher-adapters.ts";
import { classifyPublishFailure } from "../services/delivery-controller.ts";

const execFileAsync = promisify(execFile);

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected fn() to throw, but it resolved");
}

// Proves the REAL adapter code — not a parallel reimplementation of it —
// against fixtures that are never GitHub or any real remote:
//   - RealGitClient's push/read-back mechanics run against an actual local
//     bare git repository (real `git`, real refs, real fast-forward
//     enforcement), just never github.com.
//   - RealGitHubClient's request-building/parsing runs against an injected
//     fake fetch implementation with an in-memory PR store, so its actual
//     URL/header/body construction and response parsing are exercised
//     without any network call.
describe("delivery publisher — real adapters, local/fake fixtures only", () => {
  describe("RealGitClient against a local bare repository", () => {
    let workDir: string;
    let sourceDir: string;
    let bareDir: string;
    let commitSha: string;

    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), "delivery-git-client-"));
      sourceDir = join(workDir, "source");
      bareDir = join(workDir, "remote.git");
      await execFileAsync("git", ["init", "--bare", "-q", bareDir]);
      await execFileAsync("git", ["init", "-q", sourceDir]);
      await execFileAsync("git", ["-C", sourceDir, "config", "user.email", "test@example.com"]);
      await execFileAsync("git", ["-C", sourceDir, "config", "user.name", "Test"]);
      await execFileAsync("git", ["-C", sourceDir, "commit", "--allow-empty", "-q", "-m", "initial"]);
      const { stdout } = await execFileAsync("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
      commitSha = stdout.trim();
    });

    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    function client() {
      // credential: null — a local filesystem "remote" needs no auth, and
      // isGitHubHttpsRemoteUrl() correctly refuses to attach one anyway
      // since this URL is neither https nor github.com.
      return new RealGitClient({ remoteUrlResolver: () => bareDir, credential: null });
    }

    it("pushes the exact SHA and reads it back from the remote", async () => {
      const gitClient = client();
      await gitClient.pushExactSha({ repo: "acme/widgets", sha: commitSha, branch: "feat/thing", localRepoDir: sourceDir });
      const head = await gitClient.readRemoteBranchHead({ repo: "acme/widgets", branch: "feat/thing" });
      expect(head).toBe(commitSha);
    });

    it("returns null reading back a branch that was never pushed — a successful check that found nothing, not a failed check", async () => {
      const gitClient = client();
      const head = await gitClient.readRemoteBranchHead({ repo: "acme/widgets", branch: "never-pushed" });
      expect(head).toBeNull();
    });

    // The read-back verification fix: a failure to even CHECK the branch's
    // head (network/auth/unreachable) must never collapse into the same
    // null this legitimate "branch doesn't exist" case returns — a caller
    // with no way to distinguish the two would misreport a transient blip
    // as a permanent SHA mismatch. See classifyPublishFailure() and
    // runPublishExecution()'s own read-back try/catch.
    it("classifies and REthrows (does not return null) on a real DNS/connectivity failure to check the branch head", async () => {
      const unreachableClient = new RealGitClient({
        remoteUrlResolver: () => "https://delivery-controller-test-unreachable-host.invalid/repo.git",
        credential: null,
      });
      const error = await captureError(() => unreachableClient.readRemoteBranchHead({ repo: "acme/widgets", branch: "feat/thing" }));
      expect(classifyPublishFailure(error)).toBe("transient");
    }, 15_000);

    it("never force-pushes: a genuinely diverged remote branch rejects the push instead of being overwritten", async () => {
      const gitClient = client();
      await gitClient.pushExactSha({ repo: "acme/widgets", sha: commitSha, branch: "feat/thing", localRepoDir: sourceDir });

      // Diverge the remote branch from a second, unrelated source clone —
      // this commit shares no history with the one this test will now try
      // to push, so a normal (non-force) push MUST be rejected.
      const otherSourceDir = join(workDir, "other-source");
      await execFileAsync("git", ["clone", "-q", bareDir, otherSourceDir]);
      await execFileAsync("git", ["-C", otherSourceDir, "config", "user.email", "test@example.com"]);
      await execFileAsync("git", ["-C", otherSourceDir, "config", "user.name", "Test"]);
      await execFileAsync("git", ["-C", otherSourceDir, "checkout", "-q", "-b", "feat/thing", "origin/feat/thing"]);
      await execFileAsync("git", ["-C", otherSourceDir, "commit", "--allow-empty", "-q", "-m", "diverged"]);
      await execFileAsync("git", ["-C", otherSourceDir, "push", "-q", "origin", "feat/thing"]);
      const { stdout: divergedHead } = await execFileAsync("git", ["-C", otherSourceDir, "rev-parse", "HEAD"]);

      // Now attempt to push the ORIGINAL (now-stale, non-fast-forward) sha
      // again from the original source clone, which has never seen the
      // diverged commit.
      await expect(
        gitClient.pushExactSha({ repo: "acme/widgets", sha: commitSha, branch: "feat/thing", localRepoDir: sourceDir }),
      ).rejects.toThrow();

      // The remote must still be at the diverged commit — proving the
      // rejected push did not fall back to force-overwriting it.
      const head = await gitClient.readRemoteBranchHead({ repo: "acme/widgets", branch: "feat/thing" });
      expect(head).toBe(divergedHead.trim());
      expect(head).not.toBe(commitSha);
    });

    // The failure-classification fix: git wraps EVERY failure in a plain
    // Error by default, which would otherwise strip the one signal
    // (stderr text) that distinguishes "server unreachable, safe to retry"
    // from "rejected on purpose, never retry" — see classifyGitStderr() in
    // the real adapter and markPublishFailureClassification()'s own
    // comment in delivery-controller.ts.
    it("classifies a real non-fast-forward rejection (a legitimate refusal) as permanent, not transient", async () => {
      const gitClient = client();
      await gitClient.pushExactSha({ repo: "acme/widgets", sha: commitSha, branch: "feat/thing", localRepoDir: sourceDir });

      const otherSourceDir = join(workDir, "other-source-2");
      await execFileAsync("git", ["clone", "-q", bareDir, otherSourceDir]);
      await execFileAsync("git", ["-C", otherSourceDir, "config", "user.email", "test@example.com"]);
      await execFileAsync("git", ["-C", otherSourceDir, "config", "user.name", "Test"]);
      await execFileAsync("git", ["-C", otherSourceDir, "checkout", "-q", "-b", "feat/thing", "origin/feat/thing"]);
      await execFileAsync("git", ["-C", otherSourceDir, "commit", "--allow-empty", "-q", "-m", "diverged"]);
      await execFileAsync("git", ["-C", otherSourceDir, "push", "-q", "origin", "feat/thing"]);

      const error = await captureError(() =>
        gitClient.pushExactSha({ repo: "acme/widgets", sha: commitSha, branch: "feat/thing", localRepoDir: sourceDir }),
      );
      expect(classifyPublishFailure(error)).toBe("permanent");
    });

    it("classifies a real DNS/connectivity push failure as transient", async () => {
      // A genuinely unreachable host — git fails fast at DNS resolution,
      // never actually reaching a network, so this stays fast and offline.
      const unreachableClient = new RealGitClient({
        remoteUrlResolver: () => "https://delivery-controller-test-unreachable-host.invalid/repo.git",
        credential: null,
      });
      const error = await captureError(() =>
        unreachableClient.pushExactSha({ repo: "acme/widgets", sha: commitSha, branch: "feat/thing", localRepoDir: sourceDir }),
      );
      expect(classifyPublishFailure(error)).toBe("transient");
    }, 15_000);
  });

  describe("RealGitHubClient against a fake fetch implementation", () => {
    function jsonResponse(status: number, body: unknown): Response {
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }

    it("findOpenPullRequest queries the correct URL and parses a match", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, [
          {
            number: 7,
            html_url: "https://github.com/acme/widgets/pull/7",
            head: { sha: "c".repeat(40) },
            base: { ref: "master" },
            state: "open",
            merged_at: null,
          },
        ]);
      });
      const client = new RealGitHubClient({ fetchImpl, credential: { token: "tok", source: "server_env", secretName: null } });
      const result = await client.findOpenPullRequest({ repo: "acme/widgets", branch: "feat/thing", baseBranch: "master" });

      expect(result).toEqual({
        number: 7, url: "https://github.com/acme/widgets/pull/7", headSha: "c".repeat(40), baseBranch: "master", state: "open",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/repos/acme/widgets/pulls");
      // GitHub's API expects a literal "owner:branch" — only the branch
      // segment is percent-encoded, not the colon separating them.
      expect(calls[0]!.url).toContain("head=acme:feat%2Fthing");
      expect(calls[0]!.url).toContain("base=master");
      expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    });

    it("findOpenPullRequest returns null when nothing matches", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, []));
      const client = new RealGitHubClient({ fetchImpl, credential: null });
      const result = await client.findOpenPullRequest({ repo: "acme/widgets", branch: "feat/thing", baseBranch: "master" });
      expect(result).toBeNull();
    });

    it("createPullRequest POSTs the expected body and parses the created PR", async () => {
      let capturedBody: unknown;
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return jsonResponse(201, {
          number: 9,
          html_url: "https://github.com/acme/widgets/pull/9",
          head: { sha: "d".repeat(40) },
          base: { ref: "master" },
          state: "open",
          merged_at: null,
        });
      });
      const client = new RealGitHubClient({ fetchImpl, credential: null });
      const result = await client.createPullRequest({
        repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", title: "T", body: "B",
      });
      expect(result.number).toBe(9);
      expect(capturedBody).toEqual({ title: "T", body: "B", head: "feat/thing", base: "master" });
    });

    it("readPullRequest returns null for a genuine 404 (the PR does not exist) — a successful check that found nothing", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
      const client = new RealGitHubClient({ fetchImpl, credential: null });
      const result = await client.readPullRequest({ repo: "acme/widgets", prNumber: 999 });
      expect(result).toBeNull();
    });

    // The read-back verification fix, GitHub side: a 429/503 while trying
    // to read back a PR must never collapse into the same null a real 404
    // returns — same reasoning as readRemoteBranchHead above.
    it("readPullRequest classifies and REthrows (does not return null) on a 429 or 503", async () => {
      for (const status of [429, 503]) {
        const fetchImpl = vi.fn(async () => jsonResponse(status, { message: "x" }));
        const client = new RealGitHubClient({ fetchImpl, credential: null });
        const error = await captureError(() => client.readPullRequest({ repo: "acme/widgets", prNumber: 1 }));
        expect(classifyPublishFailure(error)).toBe("transient");
      }
    });

    it("readPullRequest reports merged state correctly, distinct from closed", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, {
        number: 3, html_url: "https://github.com/acme/widgets/pull/3",
        head: { sha: "e".repeat(40) }, base: { ref: "master" }, state: "closed", merged_at: "2026-01-01T00:00:00Z",
      }));
      const client = new RealGitHubClient({ fetchImpl, credential: null });
      const result = await client.readPullRequest({ repo: "acme/widgets", prNumber: 3 });
      expect(result?.state).toBe("merged");
    });

    // The failure-classification fix: every non-2xx used to collapse into a
    // single hardcoded HttpError(422), which made 429/5xx indistinguishable
    // from a real 4xx rejection — see classifyPublishFailure()'s call in
    // request()'s error branch.
    it("classifies 429 and 5xx createPullRequest failures as transient", async () => {
      for (const status of [429, 500, 502, 503, 504]) {
        const fetchImpl = vi.fn(async () => jsonResponse(status, { message: "x" }));
        const client = new RealGitHubClient({ fetchImpl, credential: null });
        const error = await captureError(() =>
          client.createPullRequest({ repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", title: "T", body: "B" }),
        );
        expect(classifyPublishFailure(error)).toBe("transient");
      }
    });

    it("classifies a 422 (real rejection — e.g. duplicate PR / invalid params) as permanent", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(422, { message: "Validation Failed" }));
      const client = new RealGitHubClient({ fetchImpl, credential: null });
      const error = await captureError(() =>
        client.createPullRequest({ repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", title: "T", body: "B" }),
      );
      expect(classifyPublishFailure(error)).toBe("permanent");
    });

    it("classifies a 403 secondary-rate-limit response (Retry-After present) as transient DESPITE the 403 status", async () => {
      // GitHub reports secondary rate limits as 403, not 429 — the
      // Retry-After header, not the status code, is the authoritative
      // signal here. A plain 403 (no Retry-After — a real auth/permission
      // failure) must NOT be classified transient; see the next test.
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
        }),
      );
      const client = new RealGitHubClient({ fetchImpl, credential: null });
      const error = await captureError(() =>
        client.createPullRequest({ repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", title: "T", body: "B" }),
      );
      expect(classifyPublishFailure(error)).toBe("transient");
    });

    it("classifies a plain 403 (no Retry-After — a real permission failure) as permanent", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(403, { message: "Resource not accessible by integration" }));
      const client = new RealGitHubClient({ fetchImpl, credential: null });
      const error = await captureError(() =>
        client.createPullRequest({ repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", title: "T", body: "B" }),
      );
      expect(classifyPublishFailure(error)).toBe("permanent");
    });

    it("classifies a connectivity failure (fetchImpl itself throws) as transient", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("Could not connect to api.github.com — ensure the URL points to a GitHub or GitHub Enterprise instance");
      });
      const client = new RealGitHubClient({ fetchImpl, credential: null });
      const error = await captureError(() =>
        client.createPullRequest({ repo: "acme/widgets", branch: "feat/thing", baseBranch: "master", title: "T", body: "B" }),
      );
      expect(classifyPublishFailure(error)).toBe("transient");
    });
  });
});
