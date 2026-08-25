import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { sep, join, resolve } from "node:path";
import { promisify } from "node:util";
import { badRequest } from "../errors.js";

const execFileAsync = promisify(execFile);

// Validates a submitted candidate's local checkout and captures a
// server-owned, immutable copy of the exact commit — the thing publish()
// actually operates on from then on, regardless of what later happens to the
// original worktree. See delivery_candidates.sourceArtifactPath's own
// comment for why this exists: a caller-supplied path is not something this
// system is willing to depend on continuing to exist.
//
// Also the sole boundary against a request naming an arbitrary host path
// and having this process run `git push` inside it — that's not just a
// filesystem-trust problem, `git push` runs the target repository's own
// client-side hooks (pre-push, etc.), so an unconstrained path is arbitrary
// code execution as this server process. See RealSourceArtifactCapturer's
// own comment for the two independent defenses (path containment + disabled
// hooks) and the branch/SHA proof.
export interface DeliverySourceArtifactCapturer {
  captureArtifact(input: {
    sourceWorktreePath: string;
    sha: string;
    branch: string; // must resolve, locally, to exactly `sha` — see below
    repo: string; // "owner/name" — checked against the worktree's own configured remote
  }): Promise<{ artifactPath: string; capturedAt: Date }>;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

// Matches the (owner, name) pair out of the handful of URL shapes a GitHub
// remote actually comes in — https, https with embedded credentials, SSH
// scp-like, and explicit ssh:// — so a worktree's `origin` can be compared
// against the declared `repo` regardless of which one was configured.
function parseGitHubOwnerRepo(remoteUrl: string): string | null {
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = remoteUrl.match(pattern);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

// `cwd` is the untrusted, caller-supplied worktree — every invocation here
// disables hooks two independent ways: `-c core.hooksPath=<empty dir>`
// (belt) and `--no-verify` on the one command that would otherwise run one
// (suspenders; --no-verify only affects commands that support it, hence the
// config override is the actual universal defense). Read-only plumbing
// commands (rev-parse, cat-file, remote) don't run hooks at all, but the
// override is applied unconditionally so no future addition to this file
// can accidentally reintroduce the gap by forgetting it on one call site.
async function gitInUntrustedWorktree(args: string[], cwd: string, noHooksDir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", `core.hooksPath=${noHooksDir}`, ...args], { encoding: "utf8", cwd });
  return stdout.trim();
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8", ...(cwd ? { cwd } : {}) });
  return stdout.trim();
}

export interface RealSourceArtifactCapturerOptions {
  /** Root directory under which one bare repo per candidate is created.
   * Caller-provided so tests can point it at a throwaway temp dir; a real
   * deployment would point it at durable, server-owned storage. */
  artifactsRoot: string;
  /** Filesystem root every submitted sourceWorktreePath MUST resolve inside
   * of (via realpath, so a symlink can't escape it) — a board request
   * cannot point capture at an arbitrary host path outside a location this
   * server itself manages as intake. This is the primary defense named by
   * the owner: "The server must only accept a managed intake location." */
  intakeRoot: string;
}

export class RealSourceArtifactCapturer implements DeliverySourceArtifactCapturer {
  constructor(private readonly options: RealSourceArtifactCapturerOptions) {}

  async captureArtifact(input: {
    sourceWorktreePath: string;
    sha: string;
    branch: string;
    repo: string;
  }): Promise<{ artifactPath: string; capturedAt: Date }> {
    if (!SHA_PATTERN.test(input.sha)) {
      throw badRequest(`Not an exact 40-character git SHA: ${JSON.stringify(input.sha)}`);
    }
    if (typeof input.branch !== "string" || input.branch.trim().length === 0) {
      throw badRequest("branch must be a non-empty string");
    }

    // 0. Path containment — checked BEFORE anything else touches the
    // filesystem or spawns git at all. resolve() first so a nonexistent
    // path still gets a sensible error instead of realpath's raw ENOENT;
    // realpath() second so a symlink pointing outside intakeRoot is caught,
    // not just a string-prefix match on the unresolved path.
    const intakeRootReal = await realpath(this.options.intakeRoot).catch((error) => {
      throw new Error(`Configured intakeRoot "${this.options.intakeRoot}" does not exist or is not accessible: ${error instanceof Error ? error.message : String(error)}`);
    });
    let sourceReal: string;
    try {
      sourceReal = await realpath(resolve(input.sourceWorktreePath));
    } catch (error) {
      throw badRequest(`sourceWorktreePath "${input.sourceWorktreePath}" does not exist: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (sourceReal !== intakeRootReal && !sourceReal.startsWith(intakeRootReal + sep)) {
      throw badRequest(
        `sourceWorktreePath "${input.sourceWorktreePath}" resolves outside the managed intake location "${this.options.intakeRoot}" — refusing to capture from an arbitrary host path`,
      );
    }

    // Empty, permanently-unpopulated hooks directory — created once,
    // reused for every capture. Passed as core.hooksPath on every git
    // invocation run inside the untrusted worktree (see
    // gitInUntrustedWorktree()) so no client-side hook in that worktree
    // (pre-push, etc.) ever executes as this server process.
    const noHooksDir = join(this.options.artifactsRoot, ".no-hooks");
    await mkdir(noHooksDir, { recursive: true });

    // 1. Is this even a git repository?
    try {
      const gitDir = await gitInUntrustedWorktree(["rev-parse", "--git-dir"], sourceReal, noHooksDir);
      if (!gitDir) throw new Error("empty --git-dir output");
    } catch (error) {
      throw badRequest(
        `sourceWorktreePath "${input.sourceWorktreePath}" is not a git repository: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 2. Does the exact commit actually exist there?
    try {
      await gitInUntrustedWorktree(["cat-file", "-e", `${input.sha}^{commit}`], sourceReal, noHooksDir);
    } catch {
      throw badRequest(`Commit ${input.sha} does not exist in ${input.sourceWorktreePath}`);
    }

    // 3. Does the submitted branch actually resolve, locally, to the
    // submitted SHA? Proves the two fields agree rather than trusting the
    // caller's word for it — a candidate whose `branch` and `sha` disagree
    // is exactly the kind of submission this exists to catch before it
    // becomes a push target.
    let branchHead: string;
    try {
      branchHead = await gitInUntrustedWorktree(["rev-parse", "--verify", `refs/heads/${input.branch}`], sourceReal, noHooksDir);
    } catch {
      throw badRequest(`Branch "${input.branch}" does not exist as a local ref in ${input.sourceWorktreePath}`);
    }
    if (branchHead.toLowerCase() !== input.sha.toLowerCase()) {
      throw badRequest(
        `Branch "${input.branch}" resolves to ${branchHead}, not the declared sha ${input.sha} — refusing to capture a branch/sha mismatch`,
      );
    }

    // 4. Does the worktree's own "origin" remote actually point at the
    // declared repo? Prevents submitting a candidate that CLAIMS to be
    // acme/widgets while the local checkout is really some other
    // repository entirely.
    let originUrl: string;
    try {
      originUrl = await gitInUntrustedWorktree(["remote", "get-url", "origin"], sourceReal, noHooksDir);
    } catch {
      throw badRequest(`sourceWorktreePath "${input.sourceWorktreePath}" has no "origin" remote configured`);
    }
    const originRepo = parseGitHubOwnerRepo(originUrl);
    if (!originRepo) {
      throw badRequest(`Could not parse a GitHub owner/repo out of origin remote "${originUrl}"`);
    }
    if (originRepo.toLowerCase() !== input.repo.toLowerCase()) {
      throw badRequest(
        `sourceWorktreePath's origin remote resolves to "${originRepo}", not the declared repo "${input.repo}" — refusing to capture`,
      );
    }

    // 5. Capture: a dedicated bare repo, created once, that this process
    // owns from here on. Pushed FROM the untrusted worktree (hooks
    // disabled two ways — see gitInUntrustedWorktree/--no-verify) INTO the
    // server-owned bare repo; nothing about the original worktree is
    // consulted again after this.
    await mkdir(this.options.artifactsRoot, { recursive: true });
    const artifactPath = join(this.options.artifactsRoot, `${input.sha}.git`);
    await git(["init", "--bare", "-q", artifactPath]);
    await execFileAsync(
      "git",
      ["-c", `core.hooksPath=${noHooksDir}`, "push", "-q", "--no-verify", artifactPath, `${input.sha}:refs/heads/captured`],
      { encoding: "utf8", cwd: sourceReal },
    );

    // 6. Verify by reading back, not by trusting the push command's exit
    // code — the same "read back what you just wrote" discipline as the
    // publisher's own pushExactSha/readRemoteBranchHead.
    const capturedHead = await git(["rev-parse", "refs/heads/captured"], artifactPath);
    if (capturedHead.toLowerCase() !== input.sha.toLowerCase()) {
      throw badRequest(
        `Artifact capture verification failed: expected ${input.sha}, artifact repo reports ${capturedHead}`,
      );
    }

    return { artifactPath, capturedAt: new Date() };
  }
}
