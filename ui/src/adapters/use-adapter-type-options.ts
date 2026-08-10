/**
 * @fileoverview Adapter dropdown options sourced from the running server's
 * adapter registry rather than a hardcoded constant.
 *
 * `AGENT_ADAPTER_TYPES` in @paperclipai/shared is a type hint, not an inventory:
 * it omits builtin types the server actually serves (grok_local, hermes_local,
 * janitor_local, provider_router_local) and every external adapter. Pickers that
 * map over it cannot represent agents that already exist, and silently drop an
 * agent's current adapter when that type is absent from the list.
 *
 * This hook builds options from the live registry and always preserves values
 * that are currently in use, so an adapter that disappeared from the running
 * build (for example after a deployment pin change) surfaces as `unavailable`
 * instead of vanishing from the menu.
 */

import { useMemo } from "react";
import { getAdapterLabel } from "./adapter-display-registry";
import { listVisibleUIAdapters } from "./metadata";
import { useDisabledAdaptersSync } from "./use-disabled-adapters";

export type AdapterTypeGroup = "in-use" | "available" | "unavailable";

export interface AdapterTypeOption {
  value: string;
  label: string;
  group: AdapterTypeGroup;
}

export interface UseAdapterTypeOptionsArgs {
  /**
   * Adapter types that existing agents already run on. These sort first so the
   * types you actually operate are the ones you reach for.
   */
  inUse?: Iterable<string | null | undefined>;
  /**
   * Values that must remain selectable even when unregistered — typically the
   * current selection of whatever control is being rendered. Without this a
   * `<Select>` bound to an unregistered type renders blank and silently
   * rewrites the agent on the next save.
   */
  preserve?: Iterable<string | null | undefined>;
}

const GROUP_ORDER: Record<AdapterTypeGroup, number> = {
  "in-use": 0,
  available: 1,
  unavailable: 2,
};

function toSet(values: Iterable<string | null | undefined> | undefined): Set<string> {
  const set = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value === "string" && value.length > 0) set.add(value);
  }
  return set;
}

export function useAdapterTypeOptions({
  inUse,
  preserve,
}: UseAdapterTypeOptionsArgs = {}): AdapterTypeOption[] {
  // Registers external adapters into the UI registry and tracks the disabled set.
  const disabledTypes = useDisabledAdaptersSync();

  const inUseKey = [...toSet(inUse)].sort().join(",");
  const preserveKey = [...toSet(preserve)].sort().join(",");

  return useMemo(() => {
    const inUseSet = toSet(inUseKey ? inUseKey.split(",") : []);
    const preserveSet = toSet(preserveKey ? preserveKey.split(",") : []);

    const registered = listVisibleUIAdapters()
      .map((adapter) => adapter.type)
      .filter((type) => !disabledTypes.has(type));

    const seen = new Set(registered);
    const options: AdapterTypeOption[] = registered.map((type) => ({
      value: type,
      label: getAdapterLabel(type),
      group: inUseSet.has(type) ? "in-use" : "available",
    }));

    // Anything still referenced but no longer served by this build.
    for (const type of [...inUseSet, ...preserveSet]) {
      if (seen.has(type)) continue;
      seen.add(type);
      options.push({
        value: type,
        label: `${getAdapterLabel(type)} (unavailable)`,
        group: "unavailable",
      });
    }

    return options.sort((a, b) => {
      const byGroup = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
      return byGroup !== 0 ? byGroup : a.label.localeCompare(b.label);
    });
  }, [disabledTypes, inUseKey, preserveKey]);
}
