// Test-only bridge for CompanionPage. Plugin UI components read all host
// hooks via `getSdkUiRuntimeValue("usePluginData")` etc., which resolves to
// `globalThis.__paperclipPluginBridge__.sdkUi[name]` (see
// packages/plugins/sdk/src/ui/runtime.ts). Installing a fake registry there
// — with real React state/effects inside each fake hook so re-renders happen
// on updates — is the intended seam for testing plugin UI without a live
// Paperclip host.
import React, { useEffect, useReducer } from "react";
import { vi } from "vitest";

interface DataEntry {
  data: unknown;
  loading: boolean;
  error: unknown;
}

export interface CompanionTestBridge {
  setData(key: string, params: Record<string, unknown> | undefined, entry: Partial<DataEntry>): void;
  setAction(key: string, handler: (params?: Record<string, unknown>) => Promise<unknown>): void;
  emitStream(channel: string, event: unknown): void;
  toast: ReturnType<typeof vi.fn>;
  dataCalls: Array<{ key: string; params?: Record<string, unknown> }>;
  actionCalls: Array<{ key: string; params?: Record<string, unknown> }>;
  refreshCalls: Array<{ key: string; params?: Record<string, unknown> }>;
}

export function installCompanionTestBridge(hostContext: { companyId: string | null; userId: string | null }): CompanionTestBridge {
  const dataState = new Map<string, DataEntry>();
  const dataListeners = new Map<string, Set<() => void>>();
  const actionHandlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>();
  const streamListeners = new Map<string, Set<() => void>>();
  const streamState = new Map<string, { events: unknown[]; lastEvent: unknown }>();
  const toast = vi.fn().mockReturnValue(null);
  const dataCalls: Array<{ key: string; params?: Record<string, unknown> }> = [];
  const actionCalls: Array<{ key: string; params?: Record<string, unknown> }> = [];
  const refreshCalls: Array<{ key: string; params?: Record<string, unknown> }> = [];

  function keyFor(key: string, params?: Record<string, unknown>) {
    return `${key}:${JSON.stringify(params ?? null)}`;
  }

  function usePluginData(key: string, params?: Record<string, unknown>) {
    dataCalls.push({ key, params });
    const storeKey = keyFor(key, params);
    const [, force] = useReducer((c: number) => c + 1, 0);
    useEffect(() => {
      let set = dataListeners.get(storeKey);
      if (!set) {
        set = new Set();
        dataListeners.set(storeKey, set);
      }
      set.add(force);
      return () => { set!.delete(force); };
    }, [storeKey]);
    const entry = dataState.get(storeKey) ?? { data: null, loading: true, error: null };
    return {
      data: entry.data,
      loading: entry.loading,
      error: entry.error,
      refresh: () => refreshCalls.push({ key, params }),
    };
  }

  function usePluginAction(key: string) {
    return async (params?: Record<string, unknown>) => {
      actionCalls.push({ key, params });
      const handler = actionHandlers.get(key);
      if (!handler) throw new Error(`ui-test-harness: no action handler registered for "${key}"`);
      return handler(params);
    };
  }

  function usePluginStream(channel: string) {
    const [, force] = useReducer((c: number) => c + 1, 0);
    useEffect(() => {
      let set = streamListeners.get(channel);
      if (!set) {
        set = new Set();
        streamListeners.set(channel, set);
      }
      set.add(force);
      return () => { set!.delete(force); };
    }, [channel]);
    const entry = streamState.get(channel) ?? { events: [], lastEvent: null };
    return { events: entry.events, lastEvent: entry.lastEvent, connecting: false, connected: true, error: null, close: () => {} };
  }

  function useHostContext() {
    return {
      companyId: hostContext.companyId,
      companyPrefix: null,
      projectId: null,
      entityId: null,
      entityType: null,
      userId: hostContext.userId,
    };
  }

  function usePluginToast() {
    return toast;
  }

  (globalThis as unknown as { __paperclipPluginBridge__: unknown }).__paperclipPluginBridge__ = {
    react: { createElement: React.createElement },
    sdkUi: { usePluginData, usePluginAction, usePluginStream, useHostContext, usePluginToast },
  };

  return {
    setData(key, params, entry) {
      const storeKey = keyFor(key, params);
      const cur = dataState.get(storeKey) ?? { data: null, loading: true, error: null };
      dataState.set(storeKey, { ...cur, ...entry });
      dataListeners.get(storeKey)?.forEach((fn) => fn());
    },
    setAction(key, handler) {
      actionHandlers.set(key, handler);
    },
    emitStream(channel, event) {
      const cur = streamState.get(channel) ?? { events: [], lastEvent: null };
      streamState.set(channel, { events: [...cur.events, event], lastEvent: event });
      streamListeners.get(channel)?.forEach((fn) => fn());
    },
    toast,
    dataCalls,
    actionCalls,
    refreshCalls,
  };
}

export function uninstallCompanionTestBridge() {
  delete (globalThis as unknown as { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__;
}
