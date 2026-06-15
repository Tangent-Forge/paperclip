import { definePlugin, runWorker, type PluginApiRequestInput, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { API_ROUTE_KEYS, JOB_KEYS, WEBHOOK_KEYS } from "./constants.js";
import { createLinearClient } from "./linear-client.js";
import { handleWebhookIssue, readConfig, readSyncStatus, runLinearSync, verifyLinearSignature } from "./linear-sync.js";

let currentContext: Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0] | null = null;

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function buildSyncDeps(companyIdOverride?: string | null) {
  const ctx = currentContext;
  if (!ctx) throw new Error("Linear sync plugin is not initialized");
  const config = readConfig(await ctx.config.get());
  const companyId = companyIdOverride ?? config.companyId;
  if (!companyId) throw new Error("companyId is required for Linear sync");
  if (!config.linearApiKeySecretRef) throw new Error("linearApiKeySecretRef is required for Linear sync");
  const token = await ctx.secrets.resolve(config.linearApiKeySecretRef);
  const linear = createLinearClient({ http: ctx.http, url: config.linearGraphqlUrl, token });
  return { ctx, config, companyId, linear };
}

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;

    ctx.jobs.register(JOB_KEYS.poll, async () => {
      const { ctx: host, config, companyId, linear } = await buildSyncDeps();
      await runLinearSync({ host, linear, config, companyId, triggerKind: "poll" });
    });

    ctx.data.register("status", async (params) => {
      const companyId = stringField(params.companyId) ?? readConfig(await ctx.config.get()).companyId;
      if (!companyId) return { configured: false, error: "companyId is not configured" };
      return readSyncStatus(ctx, companyId);
    });
  },

  async onValidateConfig(config) {
    const typed = readConfig(config);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (typed.enabled && !typed.companyId) errors.push("companyId is required when Linear sync is enabled.");
    if (typed.enabled && !typed.linearApiKeySecretRef) errors.push("linearApiKeySecretRef is required when Linear sync is enabled.");
    if (!typed.enabled) warnings.push("Linear sync is disabled; scheduled runs will be recorded as skipped and will not import issues.");
    return { ok: errors.length === 0, errors, warnings };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.linear) throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
    const { ctx, config, companyId, linear } = await buildSyncDeps();
    if (!config.enabled) return;
    if (config.linearWebhookSigningSecretRef) {
      const secret = await ctx.secrets.resolve(config.linearWebhookSigningSecretRef);
      if (!verifyLinearSignature({ rawBody: input.rawBody, headers: input.headers, secret })) {
        throw new Error("Linear webhook signature verification failed");
      }
    }
    await handleWebhookIssue({ host: ctx, linear, config, companyId, payload: input.parsedBody });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    if (input.routeKey === API_ROUTE_KEYS.status) {
      const companyId = stringField(input.query.companyId) ?? input.companyId;
      return { body: await readSyncStatus((await buildSyncDeps(companyId)).ctx, companyId) };
    }
    if (input.routeKey === API_ROUTE_KEYS.syncNow) {
      const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
      const companyId = stringField(body.companyId) ?? input.companyId;
      const { ctx, config, linear } = await buildSyncDeps(companyId);
      const summary = await runLinearSync({
        host: ctx,
        linear,
        config,
        companyId,
        triggerKind: "manual",
        actor: {
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.userId ?? null,
          actorRunId: input.actor.runId ?? null,
        },
      });
      return { status: 202, body: summary };
    }
    return { status: 404, body: { error: `Unknown Linear sync route: ${input.routeKey}` } };
  },

  async onHealth() {
    const ctx = currentContext;
    if (!ctx) return { status: "error", message: "Plugin not initialized" };
    const config = readConfig(await ctx.config.get());
    return {
      status: config.enabled && (!config.companyId || !config.linearApiKeySecretRef) ? "degraded" : "ok",
      message: config.enabled ? "Linear sync enabled" : "Linear sync disabled",
      details: {
        companyIdConfigured: Boolean(config.companyId),
        tokenSecretConfigured: Boolean(config.linearApiKeySecretRef),
        candidateStatusNames: config.candidateStatusNames,
        maxIssuesPerRun: config.maxIssuesPerRun,
      },
    };
  },

  async onShutdown() {
    currentContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
