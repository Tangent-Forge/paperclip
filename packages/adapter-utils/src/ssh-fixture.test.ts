import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshSpawnTarget,
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  prepareWorkspaceForSshExecution,
  readSshEnvLabFixtureStatus,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "./ssh.js";

const SSH_FIXTURE_TEST_TIMEOUT_MS = 30_000;
let sshEnvLabUnsupportedReason: string | null = null;

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function startSshEnvLabFixtureOrSkip(statePath: string, label: string) {
  if (sshEnvLabUnsupportedReason) {
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }

  try {
    return await startSshEnvLabFixture({ statePath });
  } catch (error) {
    sshEnvLabUnsupportedReason = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }
}

describe("ssh env-lab fixture", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("starts an isolated sshd fixture and executes commands through it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const quotedWorkspace = JSON.stringify(started.workspaceDir);
    const result = await runSshCommand(
      config,
      `cd ${quotedWorkspace} && pwd`,
    );

    expect(result.stdout.trim()).toBe(started.workspaceDir);
    const status = await readSshEnvLabFixtureStatus(statePath);
    expect(status.running).toBe(true);

    await stopSshEnvLabFixture(statePath);

    const stopped = await readSshEnvLabFixtureStatus(statePath);
    expect(stopped.running).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("forwards stdin to remote SSH commands", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH stdin forwarding test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remotePath = path.posix.join(started.workspaceDir, "stdin-forwarded.txt");

    await runSshCommand(
      config,
      `cat > ${JSON.stringify(remotePath)}`,
      {
        stdin: "hello over ssh stdin\n",
        timeoutMs: 30_000,
        maxBuffer: 256 * 1024,
      },
    );

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(remotePath)}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    expect(result.stdout).toBe("hello over ssh stdin\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("does not treat an unrelated reused pid as the running fixture", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    await stopSshEnvLabFixture(statePath);
    await mkdir(path.dirname(statePath), { recursive: true });

    await writeFile(
      statePath,
      JSON.stringify({ ...started, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );

    const staleStatus = await readSshEnvLabFixtureStatus(statePath);
    expect(staleStatus.running).toBe(false);

    const restarted = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture restart test");
    if (!restarted) return;
    expect(restarted.pid).not.toBe(process.pid);

    await stopSshEnvLabFixture(statePath);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("rejects invalid environment variable keys when constructing SSH spawn targets", async () => {
    await expect(
      buildSshSpawnTarget({
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
        command: "env",
        args: [],
        env: {
          "BAD KEY": "value",
        },
      }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("syncs a local directory into the remote fixture workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "message.txt"), "hello from paperclip\n", "utf8");
    await writeFile(path.join(localDir, "._message.txt"), "should never sync\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
    });

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(path.posix.join(remoteDir, "message.txt"))} && if [ -e ${JSON.stringify(path.posix.join(remoteDir, "._message.txt"))} ]; then echo appledouble-present; fi`,
    );

    expect(result.stdout).toContain("hello from paperclip");
    expect(result.stdout).not.toContain("appledouble-present");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("can dereference local symlinks while syncing to the remote fixture", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const sourceDir = path.join(rootDir, "source");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(sourceDir, "auth.json"), "{\"token\":\"secret\"}\n", "utf8");
    await symlink(path.join(sourceDir, "auth.json"), path.join(localDir, "auth.json"));

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH symlink sync test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-follow-links");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
      followSymlinks: true,
    });

    const result = await runSshCommand(
      config,
      `if [ -L ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))} ]; then echo symlink; else echo regular; fi && cat ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))}`,
    );

    expect(result.stdout).toContain("regular");
    expect(result.stdout).toContain("{\"token\":\"secret\"}");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips a git workspace through the SSH fixture", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(localRepo, "._tracked.txt"), "should stay local only\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    const originalHead = await git(localRepo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "dirty local\n", "utf8");
    await writeFile(path.join(localRepo, "untracked.txt"), "from local\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH workspace round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const remoteStatus = await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git status --short`,
    );
    expect(remoteStatus.stdout).toContain("M tracked.txt");
    expect(remoteStatus.stdout).toContain("?? untracked.txt");
    expect(remoteStatus.stdout).not.toContain("._tracked.txt");

    await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && git add tracked.txt untracked.txt && git commit -m "remote update" >/dev/null && printf "remote dirty\\n" > tracked.txt && printf "remote extra\\n" > remote-only.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const restoredHead = await git(localRepo, ["rev-parse", "HEAD"]);
    expect(restoredHead).not.toBe(originalHead);
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    expect(await git(localRepo, ["status", "--short"])).toContain("M tracked.txt");
    expect(await git(localRepo, ["status", "--short"])).not.toContain("._tracked.txt");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);
});
