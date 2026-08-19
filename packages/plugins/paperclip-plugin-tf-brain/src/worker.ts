import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginApiRequestInput,
  type PluginApiResponse,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, ROUTE_KEYS } from "./manifest.js";

// v0 scaffold: read-only stubs. No gbrain calls yet — the next phase wires
// the gbrain MCP at 127.0.0.1:3131 (see CLAUDE.md gbrain config) and the
// Obsidian vault filesystem reads.

function ok(body: unknown): PluginApiResponse {
  return { status: 200, body };
}

const plugin: PaperclipPlugin = definePlugin({
  async setup() {
    // TODO: register state caches, log plugin boot.
    // Intentionally empty for the v0 scaffold.
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    switch (input.routeKey) {
      case ROUTE_KEYS.overview:
        return ok({
          metrics: {
            pages: 0,
            chunks: 0,
            sources: 0,
            embed_coverage: 0,
            health_score: 0,
            orphans: 0,
            stale_pages: 0,
          },
          todo: "wire gbrain doctor / stats at http://127.0.0.1:3131/mcp",
        });
      case ROUTE_KEYS.sources:
        return ok({
          sources: [],
          todo: "wire gbrain sources_list at http://127.0.0.1:3131/mcp",
        });
      case ROUTE_KEYS.search: {
        const body = (input.body ?? {}) as { q?: string };
        const q = typeof body.q === "string" ? body.q : "";
        return ok({
          results: [],
          query: q,
          todo: "wire gbrain search/query at http://127.0.0.1:3131/mcp",
        });
      }
      case ROUTE_KEYS.audit:
        return ok({
          checks: [],
          todo: "wire gbrain doctor --json at http://127.0.0.1:3131/mcp",
        });
      default:
        return {
          status: 404,
          body: { error: `unknown route: ${input.routeKey}`, pluginId: PLUGIN_ID },
        };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
