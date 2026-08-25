import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RealSourceArtifactCapturer } from "../services/delivery-source-artifact.ts";

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8", ...(cwd ? { cwd } : {}) });
  return stdout.trim();
}

const BRANCH = "candidate-branch";

// Real git throughout — no fakes. This is exactly the thing the owner asked
// to stop trusting blindly: "do not rely on a user-supplied worktree path
// surviving," and later, "the server must only accept a managed intake
// location/artifact and disable Git hooks during capture; it must also
// prove the submitted branch resolves to the submitted SHA." Every test here
// either proves a bad submission is rejected, or proves a specific guarantee
// (survives worktree deletion, hooks never execute, path can't escape
// intakeRoot, branch/sha must actually agree) holds under real git.
describe("RealSourceArtifactCapturer — validates and captures against real git", () => {
  let workDir: string;
  let intakeRoot: string;
  let sourceDir: string;
  let artifactsRoot: string;
  let commitSha: string;

  // A fresh repo under intakeRoot, on BRANCH, with one commit — the shape
  // every fixture below starts from unless a test needs to deviate.
  async function initRepo(dir: string, options: { remote?: string; branch?: string } = {}) {
    await mkdir(dir, { recursive: true });
    await execFileAsync("git", ["init", "-q", dir]);
    // Set the branch name BEFORE the first commit (works on an unborn HEAD)
    // so tests never depend on this host's init.defaultBranch setting.
    await git(["checkout", "-q", "-b", options.branch ?? BRANCH], dir);
    await git(["config", "user.email", "test@example.com"], dir);
    await git(["config", "user.name", "Test"], dir);
    if (options.remote) {
      await git(["remote", "add", "origin", options.remote], dir);
    }
    await git(["commit", "--allow-empty", "-q", "-m", "initial"], dir);
    return git(["rev-parse", "HEAD"], dir);
  }

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "delivery-source-artifact-"));
    intakeRoot = join(workDir, "intake");
    await mkdir(intakeRoot, { recursive: true });
    artifactsRoot = join(workDir, "artifacts");
    sourceDir = join(intakeRoot, "source");
    commitSha = await initRepo(sourceDir, { remote: "https://github.com/acme/widgets.git" });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function capturer() {
    return new RealSourceArtifactCapturer({ artifactsRoot, intakeRoot });
  }

  it("captures a valid candidate: artifact repo contains the exact commit, independently verifiable", async () => {
    const result = await capturer().captureArtifact({ sourceWorktreePath: sourceDir, sha: commitSha, branch: BRANCH, repo: "acme/widgets" });
    expect(result.artifactPath).toContain(artifactsRoot);
    expect(result.capturedAt).toBeInstanceOf(Date);

    const headInArtifact = await git(["rev-parse", "refs/heads/captured"], result.artifactPath);
    expect(headInArtifact).toBe(commitSha);
  });

  it("the captured artifact survives deletion of the original worktree — the exact property this exists to guarantee", async () => {
    const result = await capturer().captureArtifact({ sourceWorktreePath: sourceDir, sha: commitSha, branch: BRANCH, repo: "acme/widgets" });

    // Simulate exactly what the owner named: the user-supplied path is gone.
    await rm(sourceDir, { recursive: true, force: true });

    // The artifact — independent of sourceDir — still has the commit, still
    // pushable from, still fully intact.
    const headAfterDeletion = await git(["rev-parse", "refs/heads/captured"], result.artifactPath);
    expect(headAfterDeletion).toBe(commitSha);
    const catFile = await git(["cat-file", "-e", `${commitSha}^{commit}`], result.artifactPath).then(() => true).catch(() => false);
    expect(catFile).toBe(true);
  });

  it("rejects a sourceWorktreePath outside the managed intake location — the primary defense against an arbitrary host path", async () => {
    const outside = join(workDir, "outside-intake", "source");
    await initRepo(outside, { remote: "https://github.com/acme/widgets.git" });
    const sha = await git(["rev-parse", "HEAD"], outside);

    await expect(
      capturer().captureArtifact({ sourceWorktreePath: outside, sha, branch: BRANCH, repo: "acme/widgets" }),
    ).rejects.toThrow(/outside the managed intake location/);
  });

  it("does not execute the source worktree's client-side git hooks during capture", async () => {
    // A pre-push hook that, if it ever runs, both leaves unmistakable
    // evidence AND fails the push outright (exit 1) — so if hooks were NOT
    // actually disabled, this test fails loudly (captureArtifact throws)
    // rather than silently passing.
    const marker = join(workDir, "hook-ran.marker");
    const hookPath = join(sourceDir, ".git", "hooks", "pre-push");
    await writeFile(hookPath, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, "utf8");
    await chmod(hookPath, 0o755);

    const result = await capturer().captureArtifact({ sourceWorktreePath: sourceDir, sha: commitSha, branch: BRANCH, repo: "acme/widgets" });
    expect(result.artifactPath).toContain(artifactsRoot);

    const markerExists = await execFileAsync("test", ["-f", marker]).then(() => true).catch(() => false);
    expect(markerExists).toBe(false);
  });

  it("rejects when the submitted branch does not resolve, locally, to the submitted sha — proves branch and sha actually agree", async () => {
    // Advance BRANCH past commitSha with a second commit — commitSha is now
    // a real, existing commit in this repo, just not what the branch points
    // at, which is exactly the mismatch this check exists to catch.
    await git(["commit", "--allow-empty", "-q", "-m", "second"], sourceDir);

    await expect(
      capturer().captureArtifact({ sourceWorktreePath: sourceDir, sha: commitSha, branch: BRANCH, repo: "acme/widgets" }),
    ).rejects.toThrow(/does not resolve to a matching branch|resolves to .* not the declared sha/);
  });

  it("rejects a branch name that doesn't exist as a local ref at all", async () => {
    await expect(
      capturer().captureArtifact({ sourceWorktreePath: sourceDir, sha: commitSha, branch: "no-such-branch", repo: "acme/widgets" }),
    ).rejects.toThrow(/does not exist as a local ref/);
  });

  it("rejects a sourceWorktreePath that isn't a git repository at all", async () => {
    const notARepo = join(intakeRoot, "not-a-repo");
    await mkdir(notARepo, { recursive: true });
    await expect(
      capturer().captureArtifact({ sourceWorktreePath: notARepo, sha: commitSha, branch: BRANCH, repo: "acme/widgets" }),
    ).rejects.toThrow(/not a git repository/);
  });

  it("rejects a commit that doesn't exist in the given worktree", async () => {
    const fakeSha = "f".repeat(40);
    await expect(
      capturer().captureArtifact({ sourceWorktreePath: sourceDir, sha: fakeSha, branch: BRANCH, repo: "acme/widgets" }),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects when the worktree's origin remote does not resolve to the declared repo — prevents repo spoofing", async () => {
    await expect(
      capturer().captureArtifact({ sourceWorktreePath: sourceDir, sha: commitSha, branch: BRANCH, repo: "someone-else/unrelated" }),
    ).rejects.toThrow(/not the declared repo/);
  });

  it("rejects a worktree with no origin remote configured", async () => {
    const noOriginDir = join(intakeRoot, "no-origin");
    const sha = await initRepo(noOriginDir);

    await expect(
      capturer().captureArtifact({ sourceWorktreePath: noOriginDir, sha, branch: BRANCH, repo: "acme/widgets" }),
    ).rejects.toThrow(/no "origin" remote/);
  });

  it("resolves both https and ssh-style GitHub remotes to the same owner/repo", async () => {
    const sshDir = join(intakeRoot, "ssh-remote");
    const sha = await initRepo(sshDir, { remote: "git@github.com:acme/widgets.git" });

    const result = await capturer().captureArtifact({ sourceWorktreePath: sshDir, sha, branch: BRANCH, repo: "acme/widgets" });
    expect(result.artifactPath).toContain(artifactsRoot);
  });
});
