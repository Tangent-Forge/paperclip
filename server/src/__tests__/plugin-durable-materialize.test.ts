import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_PLUGIN_DIR,
  resolveManagedMaterializedPluginDir,
  shouldMaterializeLocalPlugin,
} from "../services/plugin-loader.js";

describe("plugin durable materialize path helpers", () => {
  it("places managed materializations under the local plugin dir, not deploy worktrees", () => {
    const managed = resolveManagedMaterializedPluginDir(
      DEFAULT_LOCAL_PLUGIN_DIR,
      "@paperclipai/plugin-linear-sync",
      "0.1.0",
    );
    expect(managed.startsWith(DEFAULT_LOCAL_PLUGIN_DIR)).toBe(true);
    expect(managed.includes(`${path.sep}materialized${path.sep}`)).toBe(true);
    expect(managed.includes("worktrees")).toBe(false);
    expect(managed.endsWith(path.join("paperclipai__plugin-linear-sync", "0.1.0"))).toBe(true);
  });

  it("uses a stable instance-local default plugin dir", () => {
    expect(DEFAULT_LOCAL_PLUGIN_DIR.replace(/\\/g, "/")).toMatch(/\.paperclip\/plugins$/);
  });

  it("defaults durable materialize ON for Linear Sync install sources outside managed dir", () => {
    const deploySource =
      "/home/tfhub/tangent-forge/worktrees/paperclip-deploy-master-fwdport-20260811/packages/plugins/paperclip-plugin-linear-sync";
    expect(
      shouldMaterializeLocalPlugin({
        sourcePath: deploySource,
        localPluginDir: DEFAULT_LOCAL_PLUGIN_DIR,
      }),
    ).toBe(true);
  });

  it("does not re-materialize sources already under the managed plugin dir", () => {
    const alreadyManaged = path.join(DEFAULT_LOCAL_PLUGIN_DIR, "materialized", "x", "1.0.0");
    expect(
      shouldMaterializeLocalPlugin({
        sourcePath: alreadyManaged,
        localPluginDir: DEFAULT_LOCAL_PLUGIN_DIR,
      }),
    ).toBe(false);
  });

  it("honors explicit durableMaterialize false for dev link installs", () => {
    const deploySource =
      "/home/tfhub/tangent-forge/worktrees/some-pin/packages/plugins/paperclip-plugin-linear-sync";
    expect(
      shouldMaterializeLocalPlugin({
        sourcePath: deploySource,
        localPluginDir: DEFAULT_LOCAL_PLUGIN_DIR,
        durableMaterialize: false,
      }),
    ).toBe(false);
  });
});
