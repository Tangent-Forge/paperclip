import { definePlugin, runWorker, type PluginApiRequestInput, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { API_ROUTE_KEYS, JOB_KEYS, WEBHOOK_KEYS } from "./constants.js";
import { createLinearClient } from "./linear-client.js";
import { collectPortfolioInventory } from "./portfolio-inventory.js";
import { handleWebhookIssue, readConfig, readSyncStatus, runLinearSync, verifyLinearSignature } from "./linear-sync.js";
import {
  DELIVERY_STATES,
  parseWorkContract,
  reconcileWorkState,
  type CompletionEvidence,
  type DeliveryState,
  type WorkContract,
} from "./work-contract.js";

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
    if (typed.enabled && !typed.triageAgentId) errors.push("triageAgentId is required when Linear sync is enabled.");
    if (typed.enabled && (
      typed.candidateStatusNames.length !== 1
      || typed.candidateStatusNames[0]?.toLowerCase() !== "triage"
    )) {
      errors.push("candidateStatusNames must contain only Triage when Linear sync is enabled.");
    }
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
    if (input.routeKey === API_ROUTE_KEYS.reconcileWorkState) {
      if (input.method !== "POST") return { status: 405, body: { error: "Method not allowed" } };
      const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
      const evidence = body.evidence && typeof body.evidence === "object"
        ? body.evidence as Record<string, unknown>
        : null;
      const deliveryState = evidence?.deliveryState;
      if (
        !stringField(body.workId)
        || !stringField(body.linearState)
        || typeof deliveryState !== "string"
        || !(DELIVERY_STATES as readonly string[]).includes(deliveryState)
        || !Array.isArray(evidence?.receipts)
      ) {
        return { status: 400, body: { error: "workId, linearState, and valid evidence are required" } };
      }
      const parsedContract = body.contract && typeof body.contract === "object"
        ? parseWorkContract(`\`\`\`tf-work-contract\n${JSON.stringify(body.contract)}\n\`\`\``)
        : null;
      if (parsedContract && !parsedContract.valid) {
        return { status: 400, body: { error: "contract is invalid", details: parsedContract.errors } };
      }
      return {
        status: 200,
        body: reconcileWorkState({
          workId: stringField(body.workId)!,
          linearState: stringField(body.linearState)!,
          admissionReceipt: stringField(body.admissionReceipt),
          paperclipState: stringField(body.paperclipState),
          claimedDeliveryState: typeof body.claimedDeliveryState === "string"
            && (DELIVERY_STATES as readonly string[]).includes(body.claimedDeliveryState)
            ? body.claimedDeliveryState as DeliveryState
            : null,
          contract: parsedContract?.valid ? parsedContract.contract as WorkContract : null,
          evidence: {
            deliveryState: deliveryState as DeliveryState,
            receipts: (evidence.receipts as unknown[]).filter((receipt): receipt is { kind: string; ref: string } => (
              Boolean(receipt)
              && typeof receipt === "object"
              && typeof (receipt as Record<string, unknown>).kind === "string"
              && typeof (receipt as Record<string, unknown>).ref === "string"
            )),
          } satisfies CompletionEvidence,
        }),
      };
    }
    if (input.routeKey === API_ROUTE_KEYS.portfolioInventory) {
      if (input.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
      const companyId = input.companyId;
      const { linear } = await buildSyncDeps(companyId);
      const snapshot = await collectPortfolioInventory(linear, {
        source: { kind: "linear", label: "Linear", host: "api.linear.app", availability: "available" },
        pageSize: 100,
        maxPages: 50,
        maxRecords: 5000,
      });
      return { status: 200, body: snapshot };
    }
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
