import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { EXPORT_NAMES, LOCAL_FOLDER_KEYS, PAGE_ROUTE, PLUGIN_ID, SLOT_IDS } from "./constants.js";

// Paperclip Companion / Board Console / Company Console.
//
// This is a SYSTEM-LEVEL assistant surface, separate from organizational-agent
// conversations ("Talk to CEO" / "Talk to CoS" / Board Chat). It never creates
// or impersonates an organizational agent: it has no `agentId` anywhere in its
// own storage, and it never uses `ctx.agents.sessions` for its own identity
// (that client is reserved, unused in this MVP, for a possible future
// explicit-delegation action). See doc/plans/2026-08-25-paperclip-companion-design.md
// for the full identity/session decision record.
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Paperclip Companion",
  description:
    "A system-level assistant integrated into Paperclip: grounded answers about source, deployment, and runtime state, with human-approved action proposals. Not a CEO/CoS/organizational-agent conversation.",
  author: "Paperclip",
  categories: ["ui", "automation"],
  capabilities: [
    // Plugin-owned conversation storage (threads/messages/action-proposal records).
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    // Standing "Paperclip Companion (system)" issue used only as the required
    // attachment point for request_confirmation interactions (see design record §4).
    "issues.read",
    "issues.create",
    "issue.interactions.create",
    "issue.interactions.respond",
    // Read-only evidence tools.
    "agents.read",
    "http.outbound",
    "secrets.read-ref",
    "local.folders",
    // Audit trail, independent of the issue-thread interaction's own audit trail.
    "activity.log.write",
    // UI surface.
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      anthropicApiKeySecretRef: {
        type: "string",
        format: "secret-ref",
        description: "Secret reference for the Anthropic API key Companion uses to generate answers.",
      },
      model: {
        type: "string",
        default: "claude-sonnet-5",
        pattern: "^claude-[a-z0-9][a-z0-9._-]{0,119}$",
        description: "Validated Anthropic Claude model id Companion calls for answers.",
      },
      githubRepo: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$",
        description:
          "Strict \"owner/repo\" used for PR/CI lookups (e.g. Tangent-Forge/paperclip). Optional. Any value not matching this exact owner/repo shape is refused rather than used in an outbound request.",
      },
      githubTokenSecretRef: {
        type: "string",
        format: "secret-ref",
        description: "Optional secret reference for a GitHub token used for PR/CI lookups. Without it, Companion reports those lookups as not configured rather than guessing.",
      },
      githubPullRequestNumber: {
        type: "integer",
        minimum: 1,
        description:
          "Optional pull request number whose exact head and check-run state Companion should report alongside target master.",
      },
      healthCheckUrl: {
        type: "string",
        description:
          "Optional exact /api/health endpoint Companion polls for current deployment/runtime identity. Its public hostname must also be explicitly listed in healthCheckHostAllowlist. Private/reserved targets are rejected by the host HTTP boundary.",
      },
      healthCheckHostAllowlist: {
        type: "array",
        items: { type: "string" },
        description:
          "Exact public hostnames healthCheckUrl may use. No host, including loopback, is allowed implicitly. Optional; leave empty to report deployment health as not configured.",
      },
    },
  },
  // Required to actually provision this plugin's Postgres schema and run
  // migrations/migrations/001_companion.sql before worker startup — without
  // this block the host's ensureNamespaceWithClient() short-circuits
  // (`if (!manifest.database) return null`), no namespace/schema is ever
  // created, and every ctx.db.query() call at runtime throws "Plugin
  // database namespace is not active". Declaring the
  // `database.namespace.*` capabilities above is necessary but not
  // sufficient — this declaration is what wires them to an actual schema.
  // Confirmed missing (and this fix confirmed to close it) via a disposable-
  // instance install/e2e validation pass. Mirrors
  // paperclip-plugin-linear-sync's own manifest.ts `database` block.
  database: {
    namespaceSlug: "companion",
    migrationsDir: "migrations",
  },
  localFolders: [
    {
      folderKey: LOCAL_FOLDER_KEYS.evidence,
      displayName: "Deployment evidence directory",
      description:
        "Optional read-only directory of durable deployment/cutover evidence (receipts, manifests) Companion can cite. Configure per-company; Companion reports 'not configured' when absent.",
      access: "read",
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Companion",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "routeSidebar",
        id: SLOT_IDS.routeSidebar,
        displayName: "Companion",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
