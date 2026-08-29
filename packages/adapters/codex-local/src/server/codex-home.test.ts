import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSymlink, prepareManagedCodexHome, seedCodexHome } from "./codex-home.js";

describe("codex managed home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a concurrently-created expected auth symlink as success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("still throws on EEXIST when a raced-in auth symlink points elsewhere", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const wrongAuth = path.join(sharedCodexHome, "other-auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");
    await fs.writeFile(wrongAuth, '{"token":"other"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (_source, target, type) => {
      await originalSymlink(wrongAuth, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(managedAuth)).toBe(wrongAuth);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Regression for #5028: older Paperclip versions copied auth.json into the
  // managed home instead of symlinking. After upgrading to the symlink-based
  // logic, the stale regular file at the target stayed in place and every
  // subsequent codex_local run failed with refresh_token_reused as soon as the
  // source token rotated. `ensureSymlink` now heals the upgrade path by
  // unlinking the stale copy and creating a symlink to the live source.
  it("replaces a stale regular-file auth.json with a symlink to the live source (#5028)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const paperclipHome = path.join(root, "paperclip-home");
      const managedCodexHome = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-1",
        "codex-home",
      );
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const managedAuth = path.join(managedCodexHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      // The live source has rotated since the stale copy was written.
      await fs.writeFile(sharedAuth, '{"token":"fresh"}', "utf8");

      // Simulate a stale copy left by a previous Paperclip version.
      await fs.mkdir(managedCodexHome, { recursive: true });
      await fs.writeFile(managedAuth, '{"token":"stale-from-copy"}', "utf8");

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sharedCodexHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
        },
        async () => {},
        "company-1",
      );

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(managedAuth, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Direct unit coverage for the new ensureSymlink branch (#5028). The
  // regression test above goes through prepareManagedCodexHome, whose
  // pre-existing apikey-mode cleanup `fs.rm`s the stale auth.json before
  // ensureSymlink runs — so the heal branch never executes there. Call
  // ensureSymlink directly to prove the unlink-and-recreate path itself.
  it("ensureSymlink: unlinks a stale regular file and recreates the symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ensure-symlink-"));
    try {
      const source = path.join(root, "live-source.json");
      const target = path.join(root, "stale-target.json");
      await fs.writeFile(source, '{"token":"fresh"}', "utf8");
      await fs.writeFile(target, '{"token":"stale-from-copy"}', "utf8");

      await ensureSymlink(target, source);

      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The isDirectory() guard added with the heal branch must keep an unexpected
  // directory in place rather than throwing EISDIR. We treat a directory at
  // this path as operator-owned, not a stale Paperclip copy.
  it("ensureSymlink: leaves an unexpected directory in place instead of throwing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ensure-symlink-dir-"));
    try {
      const source = path.join(root, "live-source.json");
      const target = path.join(root, "unexpected-dir");
      await fs.writeFile(source, '{"token":"fresh"}', "utf8");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "sentinel"), "keep-me", "utf8");

      await expect(ensureSymlink(target, source)).resolves.toBeUndefined();

      expect((await fs.lstat(target)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(target, "sentinel"), "utf8")).toBe("keep-me");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Regression for TAN-487: an explicit per-agent CODEX_HOME override (from
  // adapter config env.CODEX_HOME) is not the company managed home, so
  // prepareManagedCodexHome never seeded it — Codex ran against an empty home
  // and failed with 401 "Missing bearer". seedCodexHome must symlink auth.json
  // into whatever effective home Codex will actually use, with zero manual steps.
  it("seedCodexHome symlinks auth.json into an explicit per-agent CODEX_HOME override", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const perAgentHome = path.join(root, "agents", "agent-1", "codex-home");
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const perAgentAuth = path.join(perAgentHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(sharedAuth, '{"token":"shared"}', "utf8");

      await seedCodexHome(perAgentHome, { CODEX_HOME: sharedCodexHome }, async () => {});

      expect((await fs.lstat(perAgentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(perAgentAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Acceptance for TAN-487: seeding an override home must leave a symlink, not a
  // copy, even when a stale regular-file auth.json was already present — copies
  // break on the next run once the source refresh token rotates (#5028).
  it("seedCodexHome replaces a stale regular-file auth.json in an override home with a symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-stale-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const perAgentHome = path.join(root, "agents", "agent-1", "codex-home");
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const perAgentAuth = path.join(perAgentHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(sharedAuth, '{"token":"fresh"}', "utf8");
      await fs.mkdir(perAgentHome, { recursive: true });
      await fs.writeFile(perAgentAuth, '{"token":"stale-copy"}', "utf8");

      await seedCodexHome(perAgentHome, { CODEX_HOME: sharedCodexHome }, async () => {});

      expect((await fs.lstat(perAgentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(perAgentAuth, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a run-attributed managed per-agent home as the shared source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-managed-source-"));
    try {
      const hostHome = path.join(root, "host");
      const hostSharedHome = path.join(hostHome, ".codex");
      const paperclipHome = path.join(root, "paperclip-home");
      const contaminatedPerAgentHome = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "codex-home",
      );
      const contaminatedAlias = path.join(root, "run-scoped-codex-home");
      const targetHome = path.join(root, "target-home");
      const logs: string[] = [];
      await fs.mkdir(hostSharedHome, { recursive: true });
      await fs.mkdir(contaminatedPerAgentHome, { recursive: true });
      await fs.symlink(contaminatedPerAgentHome, contaminatedAlias);
      await fs.writeFile(path.join(hostSharedHome, "auth.json"), '{"fixture":"host"}', "utf8");
      await fs.writeFile(path.join(contaminatedPerAgentHome, "auth.json"), '{"fixture":"agent"}', "utf8");
      vi.spyOn(os, "homedir").mockReturnValue(hostHome);

      await seedCodexHome(
        targetHome,
        {
          CODEX_HOME: contaminatedAlias,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
          PAPERCLIP_RUN_ID: "run-1",
          PAPERCLIP_AGENT_ID: "agent-2",
        },
        async (_stream, message) => {
          logs.push(message);
        },
      );

      expect(await fs.realpath(path.join(targetHome, "auth.json"))).toBe(
        await fs.realpath(path.join(hostSharedHome, "auth.json")),
      );
      expect(logs.join("")).toContain("Ignoring run-attributed CODEX_HOME");
      expect(logs.join("")).not.toContain("agent-1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a textually expected auth link when it no longer resolves", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-broken-link-"));
    try {
      const source = path.join(root, "missing-source.json");
      const target = path.join(root, "managed-auth.json");
      await fs.symlink(source, target);

      await ensureSymlink(target, source);

      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a textually expected auth link when its source is cyclic", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cyclic-link-"));
    try {
      const source = path.join(root, "source-auth.json");
      const target = path.join(root, "managed-auth.json");
      await fs.symlink(target, source);
      await fs.symlink(source, target);

      await ensureSymlink(target, source);

      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

});
