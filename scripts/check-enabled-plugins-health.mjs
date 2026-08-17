#!/usr/bin/env node
/**
 * Post-cutover / deployment health gate for enabled Paperclip plugins.
 *
 * Fails (exit 1) when any enabled plugin is in error/unhealthy state.
 * Intended to run after paperclip restart from the exact merged pin.
 *
 * Usage:
 *   node scripts/check-enabled-plugins-health.mjs [--base-url http://127.0.0.1:3100]
 */
const baseUrl = (() => {
  const idx = process.argv.indexOf("--base-url");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1].replace(/\/$/, "");
  return (process.env.PAPERCLIP_BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
})();

async function main() {
  const healthRes = await fetch(`${baseUrl}/api/health`);
  if (!healthRes.ok) {
    console.error(`paperclip health HTTP ${healthRes.status}`);
    process.exit(2);
  }
  const health = await healthRes.json();
  if (health.status !== "ok") {
    console.error(`paperclip health not ok: ${JSON.stringify(health)}`);
    process.exit(2);
  }

  const pluginsRes = await fetch(`${baseUrl}/api/plugins`);
  if (!pluginsRes.ok) {
    console.error(`plugins list HTTP ${pluginsRes.status}`);
    process.exit(2);
  }
  const payload = await pluginsRes.json();
  const plugins = Array.isArray(payload)
    ? payload
    : payload.plugins || payload.items || [];

  const failures = [];
  for (const plugin of plugins) {
    const status = plugin.status;
    const uninstalled = status === "uninstalled" || status === "disabled";
    if (uninstalled) continue;

    // Treat installed/ready/error/upgrade_pending as in-scope when not disabled.
    if (status === "error" || status === "upgrade_pending") {
      failures.push({
        id: plugin.id,
        pluginKey: plugin.pluginKey,
        status,
        lastError: plugin.lastError ?? null,
        packagePath: plugin.packagePath ?? null,
        reason: `enabled/active plugin status is ${status}`,
      });
      continue;
    }

    // Probe per-plugin health endpoint when available.
    if (plugin.id) {
      try {
        const hRes = await fetch(`${baseUrl}/api/plugins/${plugin.id}/health`);
        if (hRes.ok) {
          const h = await hRes.json();
          if (h.healthy === false || h.status === "error") {
            failures.push({
              id: plugin.id,
              pluginKey: plugin.pluginKey,
              status: h.status ?? status,
              lastError: h.lastError ?? plugin.lastError ?? null,
              packagePath: plugin.packagePath ?? null,
              reason: "plugin health endpoint reports unhealthy",
            });
          }
        }
      } catch (err) {
        failures.push({
          id: plugin.id,
          pluginKey: plugin.pluginKey,
          status,
          lastError: String(err),
          packagePath: plugin.packagePath ?? null,
          reason: "plugin health endpoint unreachable",
        });
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          baseUrl,
          failureCount: failures.length,
          failures,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        checked: plugins.length,
        message: "all non-disabled plugins healthy",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(2);
});
