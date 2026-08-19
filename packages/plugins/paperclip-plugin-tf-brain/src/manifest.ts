import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "tangentforge.brain";
const PAGE_ROUTE = "/tangentforge/brain";

const PAGE_SLOT_ID = "brain-page";
const SIDEBAR_SLOT_ID = "brain-route-sidebar";

const ROUTE_KEYS = {
  overview: "brain.overview",
  sources: "brain.sources",
  search: "brain.search",
  audit: "brain.audit",
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.0.1",
  displayName: "Brain",
  description:
    "Tangent Forge Brain Operator Dashboard — read-only visibility into gbrain (overview metrics, sources, search, and audit). v0 is read-only; no put_page / no mutation of gbrain or vault.",
  author: "Tangent Forge",
  categories: ["ui", "workspace"],
  capabilities: [
    "ui.page.register",
    "ui.sidebar.register",
    "api.routes.register",
    "http.outbound",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // v0: no instanceConfigSchema — gbrain URL is hardcoded (127.0.0.1:3131).
  // v0: no jobs (no cron).
  // v0: no webhooks.
  apiRoutes: [
    {
      routeKey: ROUTE_KEYS.overview,
      method: "GET",
      path: "/overview",
      auth: "board-or-agent",
      capability: "api.routes.register",
    },
    {
      routeKey: ROUTE_KEYS.sources,
      method: "GET",
      path: "/sources",
      auth: "board-or-agent",
      capability: "api.routes.register",
    },
    {
      routeKey: ROUTE_KEYS.search,
      method: "POST",
      path: "/search",
      auth: "board-or-agent",
      capability: "api.routes.register",
    },
    {
      routeKey: ROUTE_KEYS.audit,
      method: "GET",
      path: "/audit",
      auth: "board-or-agent",
      capability: "api.routes.register",
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: PAGE_SLOT_ID,
        displayName: "Brain",
        exportName: "BrainPage",
        routePath: PAGE_ROUTE,
      },
      {
        type: "routeSidebar",
        id: SIDEBAR_SLOT_ID,
        displayName: "Brain",
        exportName: "BrainPage",
        routePath: PAGE_ROUTE,
      },
    ],
  },
};

export { PLUGIN_ID, PAGE_ROUTE, ROUTE_KEYS };
export default manifest;
