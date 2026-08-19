import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { API_ROUTE_KEYS, PLUGIN_ID, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Council Email Intake",
  description: "Deterministic Gmail relay intake for council emails with dedupe, filtering, triage wakeups, and status reporting.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "api.routes.register",
    "webhooks.receive",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.read",
    "issues.create",
    "issues.wakeup",
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
      companyId: { type: "string", description: "Company that receives imported council email issues." },
      projectId: { type: "string", description: "Optional Paperclip project id for imported council email issues." },
      triageAgentId: { type: "string", description: "Optional triage agent woken exactly once for each new imported email." },
      defaultPriority: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium" },
      allowedSenderDomains: { type: "array", items: { type: "string" }, default: [] },
      allowedRecipientPatterns: { type: "array", items: { type: "string" }, default: ["council"] },
      subjectIncludePatterns: { type: "array", items: { type: "string" }, default: [] },
      gmailWebhookSigningSecretRef: { type: "string", description: "Secret reference used to verify Gmail relay HMAC signatures." },
      maxMessagesPerWebhook: { type: "integer", minimum: 1, maximum: 100, default: 25 }
    }
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.gmailRelay,
      displayName: "Gmail relay webhook",
      description: "Receives signed Gmail relay payloads and imports candidate council emails into Paperclip."
    }
  ],
  database: {
    namespaceSlug: "council_email_intake",
    migrationsDir: "migrations",
    coreReadTables: ["issues"]
  },
  apiRoutes: [
    {
      routeKey: API_ROUTE_KEYS.intakeNow,
      method: "POST",
      path: "/companies/:companyId/intake-now",
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
