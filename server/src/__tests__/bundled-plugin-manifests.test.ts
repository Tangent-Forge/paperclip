/**
 * @fileoverview Contract test: every bundled plugin manifest must satisfy the
 * host's manifest schema.
 *
 * Why this exists: the Plugin Manager catalog is built by regex-scraping string
 * literals out of manifest *source* (`bundledPluginMetadata` in
 * `../routes/plugins.ts`), never by validating them. Schema validation runs only
 * at install time, in `pluginLoader` -> `manifestValidator.parseOrThrow`. A
 * structurally invalid manifest therefore merges, releases, and lists in the UI
 * looking perfectly healthy, and fails for the first time when a human clicks
 * Install on a live instance.
 *
 * That is not hypothetical: `@paperclipai/plugin-tf-brain` shipped with an
 * unroutable multi-segment `routePath` and was un-installable on every instance
 * from the day it was authored until it was fixed three weeks later in #97.
 * `packages/shared/src/validators/plugin.test.ts` covers the *schema* against
 * inline fixtures; nothing covered the manifests actually shipped.
 *
 * This test closes that gap by running the real manifests through the real
 * schema, in CI, before release.
 *
 * @see Refs #97
 */
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { discoverBundledPlugins, manifestSourcePath } from "../routes/plugins.js";

/**
 * Discovery is deliberately reused from the route module rather than
 * reimplemented here. A copied package-scan would silently stop covering any
 * plugin added in a directory shape the copy did not anticipate -- which is
 * exactly the failure mode this test exists to prevent.
 */
const discovered = await discoverBundledPlugins();

const cases = discovered.map(({ entry, packageRoot, pkgJson }) => ({
  packageName: entry.packageName,
  tag: entry.tag,
  sourcePath: manifestSourcePath(packageRoot, pkgJson),
}));

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

describe("bundled plugin manifests", () => {
  it("discovers at least one bundled plugin", () => {
    // Guards against the whole suite passing vacuously if discovery breaks or
    // is pointed at the wrong root -- zero plugins would otherwise mean zero
    // assertions and a green run.
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("$packageName ($tag) declares a manifest source", ({ sourcePath }) => {
    // A bundled package whose package.json omits `paperclipPlugin.manifest`
    // cannot be validated at all, so treat a missing path as a failure rather
    // than skipping it into invisibility.
    expect(sourcePath).not.toBeNull();
  });

  it.each(cases)("$packageName ($tag) has a manifest that satisfies the host schema", async ({
    packageName,
    sourcePath,
  }) => {
    expect(sourcePath).not.toBeNull();

    const imported = (await import(pathToFileURL(sourcePath as string).href)) as {
      default?: unknown;
    };
    const manifest = imported.default;

    expect(
      manifest,
      `${packageName}: ${path.basename(sourcePath as string)} has no default export`,
    ).toBeDefined();

    const result = pluginManifestV1Schema.safeParse(manifest);

    // Mirror the detail level of the install-time error so a CI failure tells a
    // developer the same thing the Plugin Manager would have told them, without
    // needing a running instance to find out.
    expect(
      result.success,
      result.success
        ? ""
        : `${packageName} manifest is invalid (${sourcePath}):\n${formatIssues(result.error)}`,
    ).toBe(true);
  });
});
