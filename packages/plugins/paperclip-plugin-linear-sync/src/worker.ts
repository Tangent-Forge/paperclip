import { definePlugin, runWorker, type PluginApiRequestInput, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { ADMISSION_LINEAR_STATE_NAME, API_ROUTE_KEYS, JOB_KEYS, WEBHOOK_KEYS } from "./constants.js";
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
const configuredCompanyIds = new Set<string>();

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireCompanyId(value: unknown, operation: string): string {
  const companyId = stringField(value);
  if (!companyId) throw new Error(`${operation} requires an explicit companyId`);
  return companyId;
}

async function loadScopedConfig(companyIdInput: unknown) {
  const ctx = currentContext;
  if (!ctx) throw new Error("Linear sync plugin is not initialized");
  const companyId = requireCompanyId(companyIdInput, "Linear sync");
  const config = readConfig(await ctx.config.get(companyId));
  if (config.companyId !== companyId) {
    throw new Error("Linear sync config company does not match the authorized company context");
  }
  return { ctx, config, companyId };
}

async function buildSyncDeps(companyIdInput: unknown) {
  const { ctx, config, companyId } = await loadScopedConfig(companyIdInput);
  if (!config.linearApiKeySecretRef) throw new Error("linearApiKeySecretRef is required for Linear sync");
  const token = await ctx.secrets.resolve(config.linearApiKeySecretRef, {
    companyId,
    configPath: "linearApiKeySecretRef",
  });
  const linear = createLinearClient({ http: ctx.http, url: config.linearGraphqlUrl, token });
  return { ctx, config, companyId, linear };
}

async function runScopedSync(
  companyIdInput: unknown,
  triggerKind: "poll" | "manual",
  actor?: { actorAgentId?: string | null; actorRunId?: string | null; actorUserId?: string | null },
) {
  const scoped = await loadScopedConfig(companyIdInput);
  if (!scoped.config.enabled) {
    return runLinearSync({ host: scoped.ctx, config: scoped.config, companyId: scoped.companyId, linear: null, triggerKind, actor });
  }
  const deps = await buildSyncDeps(scoped.companyId);
  return runLinearSync({ host: deps.ctx, config: deps.config, companyId: deps.companyId, linear: deps.linear, triggerKind, actor });
}

function readWebhookScope(input: PluginWebhookInput): { companyId: string; payload: unknown } {
  const body = input.parsedBody && typeof input.parsedBody === "object"
    ? input.parsedBody as Record<string, unknown>
    : null;
  const companyId = requireCompanyId(input.companyId, "Linear webhook");
  const bodyCompanyId = stringField(body?.companyId);
  if (bodyCompanyId && bodyCompanyId !== companyId) {
    throw new Error("Linear webhook payload company does not match the authorized company context");
  }
  if (!configuredCompanyIds.has(companyId)) {
    throw new Error("Linear webhook company is not configured for this plugin");
  }
  return { companyId, payload: body?.payload ?? input.parsedBody };
}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    currentContext = ctx;

    ctx.jobs.register(JOB_KEYS.poll, async () => {
      if (configuredCompanyIds.size === 0) {
        throw new Error("Linear scheduled sync has no configured company scope");
      }
      for (const companyId of [...configuredCompanyIds].sort()) {
        await runScopedSync(companyId, "poll");
      }
    });

    ctx.data.register("status", async (params) => {
      const companyId = requireCompanyId(params.companyId, "Linear status lookup");
      await loadScopedConfig(companyId);
      return readSyncStatus(ctx, companyId);
    });
  },

  async onConfigChanged(newConfig, context) {
    const companyId = requireCompanyId(context?.companyId, "Linear config update");
    const config = readConfig(newConfig);
    if (!config.companyId) {
      configuredCompanyIds.delete(companyId);
      return;
    }
    if (config.companyId !== companyId) {
      throw new Error("Linear config company does not match the authorized company context");
    }
    configuredCompanyIds.add(companyId);
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
      || typed.candidateStatusNames[0]?.trim().toLowerCase() !== ADMISSION_LINEAR_STATE_NAME.toLowerCase()
    )) {
      errors.push(`candidateStatusNames must contain only "${ADMISSION_LINEAR_STATE_NAME}" when Linear sync is enabled.`);
    }
    if (!typed.enabled) warnings.push("Linear sync is disabled; scheduled runs will be recorded as skipped and will not import issues.");
    return { ok: errors.length === 0, errors, warnings };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.linear) throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
    const { companyId, payload } = readWebhookScope(input);
    const scoped = await loadScopedConfig(companyId);
    const { ctx, config } = scoped;
    if (!config.enabled) return;
    const { linear } = await buildSyncDeps(companyId);
    if (config.linearWebhookSigningSecretRef) {
      const secret = await ctx.secrets.resolve(config.linearWebhookSigningSecretRef, {
        companyId,
        configPath: "linearWebhookSigningSecretRef",
      });
      if (!verifyLinearSignature({ rawBody: input.rawBody, headers: input.headers, secret })) {
        throw new Error("Linear webhook signature verification failed");
      }
    }
    await handleWebhookIssue({ host: ctx, linear, config, companyId, payload });
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
      const companyId = requireCompanyId(input.companyId, "Linear portfolio inventory");
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
      const companyId = requireCompanyId(input.companyId, "Linear status request");
      const { ctx } = await loadScopedConfig(companyId);
      return { body: await readSyncStatus(ctx, companyId) };
    }
    if (input.routeKey === API_ROUTE_KEYS.syncNow) {
      const companyId = requireCompanyId(input.companyId, "Linear manual sync");
      const summary = await runScopedSync(companyId, "manual", {
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.userId ?? null,
          actorRunId: input.actor.runId ?? null,
      });
      return { status: 202, body: summary };
    }
    return { status: 404, body: { error: `Unknown Linear sync route: ${input.routeKey}` } };
  },

  async onHealth() {
    const ctx = currentContext;
    if (!ctx) return { status: "error", message: "Plugin not initialized" };
    return {
      status: configuredCompanyIds.size > 0 ? "ok" : "degraded",
      message: configuredCompanyIds.size > 0 ? "Linear sync has configured company scopes" : "Linear sync has no configured company scopes",
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
