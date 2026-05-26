import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { providers } from "../index.js";

/**
 * Get the configuration schema for the provider-router-local adapter.
 * Returns declarative UI field definitions for provider and model selection.
 */
export function getConfigSchema(): AdapterConfigSchema {
  const providerOptions = providers.map((p) => ({
    value: p.id,
    label: p.label,
  }));

  return {
    fields: [
      {
        key: "provider",
        type: "select",
        label: "Provider",
        hint: "Select an AI provider (must have API key configured)",
        required: true,
        options: providerOptions,
      },
      {
        key: "model",
        type: "combobox",
        label: "Model",
        hint: "Select a model from the chosen provider",
        required: true,
        // Dynamic options would be filtered based on provider selection at runtime
      },
      {
        key: "timeout",
        type: "number",
        label: "Timeout (seconds)",
        hint: "Request timeout in seconds",
        required: false,
        default: 300,
      },
      {
        key: "retries",
        type: "number",
        label: "Retries",
        hint: "Number of retry attempts on failure",
        required: false,
        default: 2,
      },
      {
        key: "fallbackProviders",
        type: "text",
        label: "Fallback Providers",
        hint: "Comma-separated list of provider IDs to try if primary fails",
        required: false,
      },
    ],
  };
}
