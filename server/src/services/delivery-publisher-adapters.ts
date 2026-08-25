import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpError } from "../errors.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { buildGitAuthInvocation, isGitHubHttpsRemoteUrl, type GitCredential } from "./git-credentials.js";
import {
  classifyPublishFailure,
  markPublishFailureClassification,
  type DeliveryGitClient,
  type DeliveryGitHubClient,
  type PublishFailureClassification,
  type PullRequestInfo,
} from "./delivery-controller.js";

// ---------------------------------------------------------------------------
// Real implementations of the delivery controller's two collaborators. Never
// constructed or invoked against a real remote anywhere in this codebase yet
// — they exist as source, exercised only against local fixtures in tests
// (see server/src/__tests__/delivery-publisher-real-adapters.test.ts). Wiring
// either of these into an actual running route/worker is a separate,
// explicitly-authorized step.
//
// Both classes below are the ONLY place that knows enough to classify their
// OWN failures correctly (git's stderr text, a GitHub response's real status
// and Retry-After header, whether a fetch() throw was connectivity vs. an
// HTTP error) — see delivery-controller.ts's markPublishFailureClassification()
// comment. Every error thrown here is explicitly stamped, on purpose, so
// classifyPublishFailure() never has to guess from a collapsed generic Error
// or a hardcoded status code.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// Git surfaces network/availability failures as plain nonzero-exit errors
// with the underlying reason only in stderr text — never a structured errno
// or HTTP status. These patterns are what actually shows up for "try again
// later" conditions over the smart-HTTP transport GitHub uses; anything NOT
// matched here (auth failure, non-fast-forward rejection, repo not found)
// stays "permanent" by classifyPublishFailure()'s own safe default.
const TRANSIENT_GIT_STDERR_PATTERNS: RegExp[] = [
  /could not resolve host/i,
  /connection timed out/i,
  /operation timed out/i,
  /connection refused/i,
  /the remote end hung up unexpectedly/i,
  /early eof/i,
  /network is unreachable/i,
  /temporarily unavailable/i,
  /returned error: (408|429|500|502|503|504)/i, // git echoes the HTTP status here when the smart-HTTP transport surfaces one
];

function classifyGitStderr(error: unknown): PublishFailureClassification {
  const stderr = typeof (error as { stderr?: unknown } | null)?.stderr === "string" ? (error as { stderr: string }).stderr : "";
  const text = `${stderr}\n${error instanceof Error ? error.message : String(error)}`;
  return TRANSIENT_GIT_STDERR_PATTERNS.some((pattern) => pattern.test(text)) ? "transient" : "permanent";
}

// A platform-level credential, deliberately NOT company-scoped: publishing
// Paperclip's own source is not a tenant concern, so this reads only the
// server process environment (same env var names git-credentials.ts already
// treats as its "server_env" fallback tier for self-hosted operators),
// never a company secret. Reuses buildGitAuthInvocation() — the same
// argv/URL-safe credential-helper mechanics createGitRemoteAuthProvider()
// uses — rather than re-inventing how the token reaches git.
export function resolvePlatformGitCredential(env: NodeJS.ProcessEnv = process.env): GitCredential | null {
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
  if (!token) return null;
  return { token, source: "server_env", secretName: null };
}

export interface RealGitClientOptions {
  /** repo ("owner/name") → remote URL. Defaults to https://github.com/<repo>.git.
   * Overridable so tests can point at a local bare repo instead of a real remote. */
  remoteUrlResolver?: (repo: string) => string;
  credential?: GitCredential | null;
}

// Real git push/read-back, over the actual `git` binary. Deliberately has no
// method for --force, deleting a ref, or anything beyond
// pushExactSha/readRemoteBranchHead — see DeliveryGitClient's own comment
// for why that's the point.
export class RealGitClient implements DeliveryGitClient {
  private readonly remoteUrlResolver: (repo: string) => string;
  private readonly credential: GitCredential | null;

  constructor(options: RealGitClientOptions = {}) {
    this.remoteUrlResolver = options.remoteUrlResolver ?? ((repo) => `https://github.com/${repo}.git`);
    this.credential = options.credential !== undefined ? options.credential : resolvePlatformGitCredential();
  }

  private authArgsAndEnv(remoteUrl: string): { configArgs: string[]; env: NodeJS.ProcessEnv } {
    if (!isGitHubHttpsRemoteUrl(remoteUrl) || !this.credential) {
      return { configArgs: [], env: process.env };
    }
    const invocation = buildGitAuthInvocation(this.credential);
    return { configArgs: invocation.configArgs, env: { ...process.env, ...invocation.env } };
  }

  async pushExactSha(input: { repo: string; sha: string; branch: string; localRepoDir: string }): Promise<void> {
    const remoteUrl = this.remoteUrlResolver(input.repo);
    const { configArgs, env } = this.authArgsAndEnv(remoteUrl);
    try {
      // Run FROM localRepoDir (`-C`) — the commit object only exists in
      // whatever local checkout the candidate was submitted from; this
      // process has no other way to locate it. No --force anywhere in this
      // argument list, ever. A non-fast-forward remote rejects this and
      // execFileAsync throws — that's the intended outcome, surfaced by the
      // caller as publish_failed, not silently retried with force.
      await execFileAsync(
        "git",
        ["-C", input.localRepoDir, ...configArgs, "push", remoteUrl, `${input.sha}:refs/heads/${input.branch}`],
        { env },
      );
    } catch (error) {
      // classifyGitStderr() reads the ORIGINAL error's stderr — do this
      // before wrapping, since the wrapped Error below has none.
      const classification = classifyGitStderr(error);
      throw markPublishFailureClassification(
        new Error(
          `git push ${input.repo} ${input.sha.slice(0, 12)}:${input.branch} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        classification,
      );
    }
  }

  async readRemoteBranchHead(input: { repo: string; branch: string }): Promise<string | null> {
    const remoteUrl = this.remoteUrlResolver(input.repo);
    const { configArgs, env } = this.authArgsAndEnv(remoteUrl);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "git",
        [...configArgs, "ls-remote", remoteUrl, `refs/heads/${input.branch}`],
        { env },
      ));
    } catch (error) {
      // A FAILED ls-remote (nonzero exit — network/auth/unreachable repo)
      // means we could not determine the branch's head at all. That is a
      // different fact from "ls-remote succeeded and found nothing", which
      // is how git reports a genuinely absent branch (exit 0, empty
      // stdout — see below, never reaches this catch). Conflating the two
      // by returning null here would misreport a transient blip as "the
      // branch doesn't exist" to a caller with no way to tell the
      // difference — classify and rethrow instead; see
      // DeliveryGitClient.readRemoteBranchHead's own contract comment.
      throw markPublishFailureClassification(
        new Error(`git ls-remote ${input.repo} refs/heads/${input.branch} failed: ${error instanceof Error ? error.message : String(error)}`),
        classifyGitStderr(error),
      );
    }
    const line = stdout.trim().split("\n")[0] ?? "";
    const sha = line.split(/\s+/)[0];
    return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  }
}

export interface RealGitHubClientOptions {
  fetchImpl?: typeof ghFetch;
  hostname?: string;
  credential?: GitCredential | null;
}

interface GitHubPullRequestApiShape {
  number: number;
  html_url: string;
  head: { sha: string };
  base: { ref: string };
  state: "open" | "closed";
  merged_at: string | null;
}

function toPullRequestInfo(pr: GitHubPullRequestApiShape): PullRequestInfo {
  return {
    number: pr.number,
    url: pr.html_url,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
  };
}

// Real GitHub REST API calls (via this codebase's existing ghFetch/gitHubApiBase
// helpers), reading the same platform-level credential as RealGitClient.
// Same restricted surface as the interface it implements: no merge endpoint
// call exists here, so publish() has nothing to invoke even if it wanted to.
export class RealGitHubClient implements DeliveryGitHubClient {
  private readonly fetchImpl: typeof ghFetch;
  private readonly hostname: string;
  private readonly credential: GitCredential | null;

  constructor(options: RealGitHubClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ghFetch;
    this.hostname = options.hostname ?? "github.com";
    this.credential = options.credential !== undefined ? options.credential : resolvePlatformGitCredential();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    if (this.credential) headers.Authorization = `Bearer ${this.credential.token}`;
    return headers;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${gitHubApiBase(this.hostname)}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers: { ...this.headers(), ...(init?.headers ?? {}) } });
    } catch (error) {
      // ghFetch() only ever throws for a genuine failure to connect (DNS,
      // TLS, connection refused, etc.) — it never throws for an HTTP
      // response, even an error one (that's the `!res.ok` branch below).
      // A connectivity failure is unambiguously transient.
      throw markPublishFailureClassification(error instanceof Error ? error : new Error(String(error)), "transient");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Preserve GitHub's REAL status — collapsing every failure to a fixed
      // 422 was exactly what made classifyPublishFailure()'s HTTP-status
      // heuristic useless for this adapter (429/5xx never survived to be
      // seen). retryAfter overrides the status-based guess explicitly:
      // GitHub reports SECONDARY rate limits as 403 (not 429), always with
      // a Retry-After header — that header, not the status code, is the
      // authoritative "try again later" signal in that specific case.
      const retryAfter = res.headers.get("retry-after");
      const classification: PublishFailureClassification = retryAfter ? "transient" : classifyPublishFailure(new HttpError(res.status, ""));
      throw markPublishFailureClassification(
        new HttpError(res.status, `GitHub API ${init?.method ?? "GET"} ${path} returned ${res.status}: ${body.slice(0, 500)}`),
        classification,
      );
    }
    return res.json() as Promise<T>;
  }

  async findOpenPullRequest(input: { repo: string; branch: string; baseBranch: string }): Promise<PullRequestInfo | null> {
    const [owner] = input.repo.split("/");
    const results = await this.request<GitHubPullRequestApiShape[]>(
      `/repos/${input.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(input.branch)}&base=${encodeURIComponent(input.baseBranch)}`,
    );
    const match = results.find((pr) => pr.base.ref === input.baseBranch);
    return match ? toPullRequestInfo(match) : null;
  }

  async createPullRequest(input: {
    repo: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestInfo> {
    const created = await this.request<GitHubPullRequestApiShape>(`/repos/${input.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, head: input.branch, base: input.baseBranch }),
    });
    return toPullRequestInfo(created);
  }

  async readPullRequest(input: { repo: string; prNumber: number }): Promise<PullRequestInfo | null> {
    try {
      const pr = await this.request<GitHubPullRequestApiShape>(`/repos/${input.repo}/pulls/${input.prNumber}`);
      return toPullRequestInfo(pr);
    } catch (error) {
      // A genuine 404 means the PR does not exist — the only case this
      // returns null for. Anything else (429/5xx/403/connectivity) is
      // request()'s own already-classified error — rethrow it rather than
      // collapsing every failure into "not found"; see
      // DeliveryGitHubClient.readPullRequest's own contract comment.
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }
}
