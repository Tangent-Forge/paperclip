import { definePlugin, runWorker, type PluginApiRequestInput, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { API_ROUTE_KEYS, WEBHOOK_KEYS } from "./constants.js";
import {
  extractEmailMessages,
  readConfig,
  readIntakeStatus,
  runEmailIntake,
  verifyWebhookSignature,
} from "./council-email-intake.js";

let currentContext: Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0] | null = null;

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function buildDeps(companyIdOverride?: string | null) {
  const ctx = currentContext;
  if (!ctx) throw new Error("Council email intake plugin is not initialized");
  const config = readConfig(await ctx.config.get());
  const companyId = companyIdOverride ?? config.companyId;
  if (!companyId) throw new Error("companyId is required for council email intake");
  return { ctx, config, companyId };
}

async function verifyIfConfigured(input: PluginWebhookInput, secretRef: string | null): Promise<void> {
  const ctx = currentContext;
  if (!ctx || !secretRef) return;
  const secret = await ctx.secrets.resolve(secretRef);
  if (!verifyWebhookSignature({ rawBody: input.rawBody, headers: input.headers, secret })) {
    throw new Error("Gmail relay webhook signature verification failed");
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;

    ctx.data.register("status", async (params) => {
      const companyId = stringField(params.companyId) ?? readConfig(await ctx.config.get()).companyId;
      if (!companyId) return { configured: false, error: "companyId is not configured" };
      return readIntakeStatus(ctx, companyId);
    });
  },

  async onValidateConfig(config) {
    const typed = readConfig(config);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (typed.enabled && !typed.companyId) errors.push("companyId is required when council email intake is enabled.");
    if (typed.enabled && !typed.gmailWebhookSigningSecretRef) warnings.push("No Gmail relay signing secret is configured; webhook authenticity will not be verified.");
    if (!typed.enabled) warnings.push("Council email intake is disabled; webhook and manual runs will be recorded as skipped.");
    return { ok: errors.length === 0, errors, warnings };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.gmailRelay) throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
    const { ctx, config, companyId } = await buildDeps();
    await verifyIfConfigured(input, config.gmailWebhookSigningSecretRef);
    const messages = extractEmailMessages(input.parsedBody ?? JSON.parse(input.rawBody || "{}"));
    await runEmailIntake({ host: ctx, companyId, config, messages, triggerKind: "webhook" });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    if (input.routeKey === API_ROUTE_KEYS.status) {
      const companyId = stringField(input.query.companyId) ?? input.companyId;
      const { ctx } = await buildDeps(companyId);
      return { body: await readIntakeStatus(ctx, companyId) };
    }
    if (input.routeKey === API_ROUTE_KEYS.intakeNow) {
      const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
      const companyId = stringField(body.companyId) ?? input.companyId;
      const { ctx, config } = await buildDeps(companyId);
      const messages = extractEmailMessages(body.messages ?? body.message ?? body);
      const summary = await runEmailIntake({
        host: ctx,
        companyId,
        config,
        messages,
        triggerKind: "manual",
        actor: {
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.userId ?? null,
          actorRunId: input.actor.runId ?? null,
        },
      });
      return { status: 202, body: summary };
    }
    return { status: 404, body: { error: `Unknown council email intake route: ${input.routeKey}` } };
  },

  async onHealth() {
    const ctx = currentContext;
    if (!ctx) return { status: "error", message: "Plugin not initialized" };
    const config = readConfig(await ctx.config.get());
    return {
      status: config.enabled && !config.companyId ? "degraded" : "ok",
      message: config.enabled ? "Council email intake enabled" : "Council email intake disabled",
      details: {
        companyIdConfigured: Boolean(config.companyId),
        signingSecretConfigured: Boolean(config.gmailWebhookSigningSecretRef),
        triageAgentConfigured: Boolean(config.triageAgentId),
        maxMessagesPerWebhook: config.maxMessagesPerWebhook,
      },
    };
  },

  async onShutdown() {
    currentContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
