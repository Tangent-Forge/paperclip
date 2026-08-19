import { definePlugin, runWorker, type EnvSecretRefBinding, type PluginApiRequestInput, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { API_ROUTE_KEYS, WEBHOOK_KEYS } from "./constants.js";
import {
  extractEmailMessages,
  readConfig,
  readIntakeStatus,
  runEmailIntake,
  verifyWebhookSignature,
} from "./council-email-intake.js";

let currentContext: Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0] | null = null;
const configuredCompanyIds = new Set<string>();

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireCompanyId(value: unknown, operation: string): string {
  const companyId = stringField(value);
  if (!companyId) throw new Error(`${operation} requires an explicit companyId`);
  return companyId;
}

async function buildDeps(companyIdInput: unknown) {
  const ctx = currentContext;
  if (!ctx) throw new Error("Council email intake plugin is not initialized");
  const companyId = requireCompanyId(companyIdInput, "Council email intake");
  const config = readConfig(await ctx.config.get(companyId));
  if (config.companyId !== companyId) {
    throw new Error("Council email intake config company does not match the authorized company context");
  }
  return { ctx, config, companyId };
}

async function verifyIfConfigured(
  input: PluginWebhookInput,
  companyId: string,
  secretRef: EnvSecretRefBinding | null,
): Promise<void> {
  const ctx = currentContext;
  if (!ctx || !secretRef) return;
  const secret = await ctx.secrets.resolve(secretRef, {
    companyId,
    configPath: "gmailWebhookSigningSecretRef",
  });
  if (!verifyWebhookSignature({ rawBody: input.rawBody, headers: input.headers, secret })) {
    throw new Error("Gmail relay webhook signature verification failed");
  }
}

function readWebhookScope(input: PluginWebhookInput): { companyId: string; payload: unknown } {
  const body = input.parsedBody && typeof input.parsedBody === "object"
    ? input.parsedBody as Record<string, unknown>
    : null;
  const companyId = requireCompanyId(input.companyId, "Council email webhook");
  const bodyCompanyId = stringField(body?.companyId);
  if (bodyCompanyId && bodyCompanyId !== companyId) {
    throw new Error("Council email webhook payload company does not match the authorized company context");
  }
  if (!configuredCompanyIds.has(companyId)) {
    throw new Error("Council email webhook company is not configured for this plugin");
  }
  return { companyId, payload: body?.payload ?? input.parsedBody };
}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    currentContext = ctx;

    ctx.data.register("status", async (params) => {
      const companyId = requireCompanyId(params.companyId, "Council email status lookup");
      await buildDeps(companyId);
      return readIntakeStatus(ctx, companyId);
    });
  },

  async onConfigChanged(newConfig, context) {
    const companyId = requireCompanyId(context?.companyId, "Council email config update");
    const config = readConfig(newConfig);
    if (!config.companyId) {
      configuredCompanyIds.delete(companyId);
      return;
    }
    if (config.companyId !== companyId) {
      throw new Error("Council email intake config company does not match the authorized company context");
    }
    configuredCompanyIds.add(companyId);
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
    const { companyId, payload } = readWebhookScope(input);
    const { ctx, config } = await buildDeps(companyId);
    await verifyIfConfigured(input, companyId, config.gmailWebhookSigningSecretRef);
    const messages = extractEmailMessages(payload ?? JSON.parse(input.rawBody || "{}"));
    await runEmailIntake({ host: ctx, companyId, config, messages, triggerKind: "webhook" });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    if (input.routeKey === API_ROUTE_KEYS.status) {
      const companyId = requireCompanyId(input.companyId, "Council email status request");
      const { ctx } = await buildDeps(companyId);
      return { body: await readIntakeStatus(ctx, companyId) };
    }
    if (input.routeKey === API_ROUTE_KEYS.intakeNow) {
      const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
      const companyId = requireCompanyId(input.companyId, "Council email manual intake");
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
    return {
      status: configuredCompanyIds.size > 0 ? "ok" : "degraded",
      message: configuredCompanyIds.size > 0 ? "Council email intake has configured company scopes" : "Council email intake has no configured company scopes",
      details: {
        configuredCompanyCount: configuredCompanyIds.size,
      },
    };
  },

  async onShutdown() {
    currentContext = null;
    configuredCompanyIds.clear();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
