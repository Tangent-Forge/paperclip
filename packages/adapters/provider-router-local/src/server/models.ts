import { providers } from "../index.js";

/**
 * Get available models for a specific provider.
 * Validates that the provider's API key is configured in the environment.
 */
export async function getProviderModels(providerId: string) {
  const provider = providers.find((p: typeof providers[number]) => p.id === providerId);

  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Check if the provider's API key is configured
  const apiKey = process.env[provider.envKey];
  if (!apiKey || apiKey.startsWith("PLACEHOLDER")) {
    throw new Error(
      `Provider '${provider.label}' is not configured. Set ${provider.envKey} in your environment.`
    );
  }

  // Return the provider's models
  return provider.models;
}

/**
 * Validate that a selected model belongs to the specified provider.
 * Returns true if valid, throws if invalid.
 */
export async function validateProviderModel(
  providerId: string,
  modelId: string
): Promise<boolean> {
  const models = await getProviderModels(providerId);

  const modelExists = models.some((m: typeof models[number]) => m.id === modelId);
  if (!modelExists) {
    const availableModels = models.map((m: typeof models[number]) => m.id).join(", ");
    throw new Error(
      `Model '${modelId}' is not available for provider '${providerId}'. Available models: ${availableModels}`
    );
  }

  return true;
}

/**
 * Get all configured providers (those with API keys set).
 * Returns array of provider objects with their metadata.
 */
export async function getConfiguredProviders() {
  return providers.filter((provider: typeof providers[number]) => {
    const apiKey = process.env[provider.envKey];
    return apiKey && !apiKey.startsWith("PLACEHOLDER");
  });
}

/**
 * Get all available models across all configured providers.
 * Useful for global model discovery across providers the user has keys for.
 */
export async function getAllConfiguredModels() {
  const configured = await getConfiguredProviders();
  return configured.flatMap((p: typeof configured[number]) => p.models);
}
