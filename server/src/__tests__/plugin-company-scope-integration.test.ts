import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { HostServices, PaperclipPluginManifestV1, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import linearManifest from "../../../packages/plugins/paperclip-plugin-linear-sync/src/manifest.js";
import councilManifest from "../../../packages/plugins/paperclip-plugin-council-email-intake/src/manifest.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TSX_LOADER = path.join(ROOT, "cli/node_modules/tsx/dist/loader.mjs");
const companies = ["company-a", "company-b"] as const;

function secretRef(secretId: string) {
  return { type: "secret_ref", secretId, version: "latest" };
}

function createWorker(manifest: PaperclipPluginManifestV1, source: string, configs: Map<string, Record<string, unknown>>) {
  const configGet = vi.fn(async ({ companyId }: { companyId: string }) => configs.get(companyId) ?? null);
  const secretsResolve = vi.fn(async ({ companyId }: { companyId: string }) => `secret-${companyId}`);
  const handlers = createHostClientHandlers({
    pluginId: manifest.id,
    capabilities: manifest.capabilities ?? [],
    services: {
      config: { get: configGet },
      secrets: { resolve: secretsResolve },
      state: { get: vi.fn(async () => null), set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
      db: { namespace: vi.fn(async () => "plugin_test"), query: vi.fn(async () => []), execute: vi.fn(async () => ({ rowCount: 0 })) },
    } as unknown as HostServices,
  });
  return {
    handle: createPluginWorkerHandle(manifest.id, {
      entrypointPath: path.join(ROOT, source),
      execArgv: ["--import", TSX_LOADER],
      manifest,
      config: {},
      instanceInfo: { instanceId: "scope-test", hostVersion: "1.0.0" },
      apiVersion: manifest.apiVersion,
      databaseNamespace: "plugin_test",
      hostHandlers: handlers,
      proactiveCompanyScopes: [...companies],
    }),
    configGet,
    secretsResolve,
  };
}

function linearConfig(companyId: string, enabled: boolean) {
  return {
    enabled,
    companyId,
    linearApiKeySecretRef: secretRef(`linear-${companyId}`),
    linearWebhookSigningSecretRef: secretRef(`webhook-${companyId}`),
    triageAgentId: "triage-agent",
    candidateStatusNames: ["Triage"],
  };
}

function councilConfig(companyId: string) {
  return { enabled: true, companyId, gmailWebhookSigningSecretRef: secretRef(`gmail-${companyId}`) };
}

function scopedCalls(fn: ReturnType<typeof vi.fn>) {
  return fn.mock.calls.map(([params, context]) => [
    (params as { companyId?: string }).companyId,
    (context as { invocationScope?: { companyId?: string } } | undefined)?.invocationScope?.companyId,
  ]);
}

describe("company-scoped plugin worker boundary", () => {
  it("keeps Linear scheduled and webhook host calls on the requested company", async () => {
    const configs = new Map(companies.map((id) => [id, linearConfig(id, false)]));
    const { handle, configGet, secretsResolve } = createWorker(
      linearManifest,
      "packages/plugins/paperclip-plugin-linear-sync/src/worker.ts",
      configs,
    );
    try {
      await handle.start();
      for (const companyId of companies) await handle.call("configChanged", { companyId, config: configs.get(companyId) });
      await expect(handle.call("runJob", { job: { jobKey: "poll-linear-intake", runId: "scheduled", trigger: "schedule" } })).resolves.toBeNull();
      expect(scopedCalls(configGet)).toEqual([["company-a", "company-a"], ["company-b", "company-b"]]);

      for (const companyId of companies) {
        configs.set(companyId, linearConfig(companyId, true));
        await handle.call("configChanged", { companyId, config: configs.get(companyId) });
      }
      const webhook = (companyId: string, payloadCompanyId = companyId): PluginWebhookInput => ({
        endpointKey: "linear",
        companyId,
        rawBody: JSON.stringify({ companyId: payloadCompanyId, payload: {} }),
        parsedBody: { companyId: payloadCompanyId, payload: {} },
        headers: { "linear-signature": "invalid" },
      });
      await expect(handle.call("handleWebhook", webhook("company-a"))).rejects.toThrow(/signature verification failed/);
      await expect(handle.call("handleWebhook", webhook("company-b"))).rejects.toThrow(/signature verification failed/);
      await expect(handle.call("handleWebhook", webhook("company-a", "company-b"))).rejects.toThrow(/does not match/);
      await expect(handle.call("handleWebhook", { ...webhook("company-a"), companyId: undefined })).rejects.toThrow(/explicit companyId/);
      expect(scopedCalls(configGet).slice(-4)).toEqual([
        ["company-a", "company-a"], ["company-a", "company-a"],
        ["company-b", "company-b"], ["company-b", "company-b"],
      ]);
      expect(scopedCalls(secretsResolve)).toEqual([
        ["company-a", "company-a"], ["company-a", "company-a"],
        ["company-b", "company-b"], ["company-b", "company-b"],
      ]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("keeps Council webhook config and secret calls company-scoped", async () => {
    const configs = new Map(companies.map((id) => [id, councilConfig(id)]));
    const { handle, configGet, secretsResolve } = createWorker(
      councilManifest,
      "packages/plugins/paperclip-plugin-council-email-intake/src/worker.ts",
      configs,
    );
    try {
      await handle.start();
      for (const companyId of companies) await handle.call("configChanged", { companyId, config: configs.get(companyId) });
      for (const companyId of companies) {
        const rawBody = JSON.stringify({ companyId, payload: { messages: [] } });
        await expect(handle.call("handleWebhook", {
          endpointKey: "gmail-relay", companyId, rawBody, parsedBody: { companyId, payload: { messages: [] } }, headers: {},
        })).rejects.toThrow(/signature verification failed/);
      }
      await expect(handle.call("handleWebhook", {
        endpointKey: "gmail-relay", companyId: "company-a", rawBody: "{}", parsedBody: { companyId: "company-b" }, headers: {},
      })).rejects.toThrow(/does not match/);
      await expect(handle.call("handleWebhook", {
        endpointKey: "gmail-relay", rawBody: "{}", parsedBody: {}, headers: {},
      })).rejects.toThrow(/explicit companyId/);
      expect(scopedCalls(configGet)).toEqual([["company-a", "company-a"], ["company-b", "company-b"]]);
      expect(scopedCalls(secretsResolve)).toEqual([["company-a", "company-a"], ["company-b", "company-b"]]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
