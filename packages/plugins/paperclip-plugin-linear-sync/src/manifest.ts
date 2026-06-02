import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { API_ROUTE_KEYS, JOB_KEYS, PLUGIN_ID, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Linear Sync",
  description: "Deterministic Linear-to-Paperclip intake sync with dedupe, bounded polling, retries, incidents, and observability.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "api.routes.register",
    "webhooks.receive",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "activity.log.write",
    "metrics.write",
    "telemetry.track"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: false },
      companyId: { type: "string", description: "Company to sync when the scheduled poller runs." },
      linearApiKeySecretRef: { type: "string", description: "Secret reference for the Linear API key." },
      linearWebhookSigningSecretRef: { type: "string", description: "Optional secret reference used to verify Linear webhook signatures." },
      linearGraphqlUrl: { type: "string", default: "https://api.linear.app/graphql" },
      candidateStatusNames: { type: "array", items: { type: "string" }, default: ["Backlog", "Todo"] },
      maxIssuesPerRun: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      projectId: { type: "string", description: "Optional Paperclip project id for imported intake items." },
      triageAgentId: { type: "string", description: "Optional Paperclip agent woken exactly once for each new imported issue." },
      defaultPriority: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium" },
      postImportComment: { type: "boolean", default: true },
      importedStateId: { type: "string", description: "Optional Linear workflow state id to move issues to after Paperclip creation succeeds." },
      failureIncidentThreshold: { type: "integer", minimum: 1, maximum: 25, default: 3 },
      failureCooldownMinutes: { type: "integer", minimum: 1, maximum: 1440, default: 60 },
      successLookbackMinutes: { type: "integer", minimum: 1, maximum: 10080, default: 60 }
    }
  },
  jobs: [
    {
      jobKey: JOB_KEYS.poll,
      displayName: "Poll Linear intake",
      description: "Imports bounded Backlog/Todo Linear issues into Paperclip with explicit sync state.",
      schedule: "*/30 * * * *"
    }
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.linear,
      displayName: "Linear issue webhook",
      description: "Receives Linear issue create/update events and imports eligible issues deterministically."
    }
  ],
  database: {
    namespaceSlug: "linear_sync",
    migrationsDir: "migrations",
    coreReadTables: ["issues"]
  },
  apiRoutes: [
    {
      routeKey: API_ROUTE_KEYS.syncNow,
      method: "POST",
      path: "/companies/:companyId/sync-now",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: API_ROUTE_KEYS.status,
      method: "GET",
      path: "/companies/:companyId/status",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" }
    }
  ]
};

export default manifest;
