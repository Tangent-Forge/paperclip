import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { providers } from "../index.js";
import { validateProviderModel } from "./models.js";

/**
 * Adapter-compliant execute function.
 * Accepts AdapterExecutionContext and extracts provider/model configuration.
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config as Record<string, unknown>;
  const providerId = typeof config.provider === "string" ? config.provider : "";
  const modelId = typeof config.model === "string" ? config.model : "";

  if (!providerId || !modelId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Provider and model must be configured",
      errorCode: "MISSING_CONFIG",
    };
  }

  // Extract execution parameters from context
  const messages = Array.isArray(config.messages) ? config.messages : [];
  const systemPrompt = typeof config.systemPrompt === "string" ? config.systemPrompt : undefined;
  const temperature = typeof config.temperature === "number" ? config.temperature : undefined;
  const maxTokens = typeof config.maxTokens === "number" ? config.maxTokens : undefined;
  const timeout = typeof config.timeout === "number" ? config.timeout : 300;
  const retries = typeof config.retries === "number" ? config.retries : 2;

  try {
    const result = await executeWithProvider({
      provider: providerId,
      model: modelId,
      messages,
      systemPrompt,
      temperature,
      maxTokens,
      timeout,
      retries,
    });

    // Check if result indicates an error
    if (result.error) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: result.error,
        errorCode: "PROVIDER_ERROR",
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: result,
      summary: result.choices?.[0]?.message?.content || "No response",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      exitCode: 1,
      signal: null,
      timedOut: message.includes("timeout"),
      errorMessage: message,
      errorCode: message.includes("timeout") ? "TIMEOUT" : "EXECUTION_ERROR",
    };
  }
}

/**
 * Execute a request using the specified provider and model.
 * Routes the request to the appropriate provider's API endpoint.
 */
export async function executeWithProvider(config: {
  provider: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { provider: providerId, model: modelId, messages, systemPrompt, temperature, maxTokens, timeout = 300, retries = 2 } = config;

  // Validate the provider exists
  const provider = providers.find((p: typeof providers[number]) => p.id === providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Validate the model is available for this provider
  await validateProviderModel(providerId, modelId);

  // Check that the provider's API key is configured
  const apiKey = process.env[provider.envKey];
  if (!apiKey || apiKey.startsWith("PLACEHOLDER")) {
    throw new Error(
      `Provider '${provider.label}' is not configured. Set ${provider.envKey} in your environment.`
    );
  }

  // Route to the appropriate provider's implementation
  switch (providerId) {
    case "openrouter":
      return executeOpenRouter({
        apiKey,
        model: modelId,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeout,
        retries,
      });

    case "fireworks":
      return executeFireworks({
        apiKey,
        model: modelId,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeout,
        retries,
      });

    case "together":
      return executeTogether({
        apiKey,
        model: modelId,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeout,
        retries,
      });

    case "groq":
      return executeGroq({
        apiKey,
        model: modelId,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeout,
        retries,
      });

    case "kimi":
      return executeKimi({
        apiKey,
        model: modelId,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeout,
        retries,
      });

    case "deepseek":
      return executeDeepSeek({
        apiKey,
        model: modelId,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeout,
        retries,
      });

    case "quin":
      return executeQuin({
        apiKey,
        model: modelId,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeout,
        retries,
      });

    case "complexity":
      return executeComplexity({
        apiKey,
        model: modelId,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        timeout,
        retries,
      });

    default:
      throw new Error(`No implementation for provider: ${providerId}`);
  }
}

/**
 * OpenRouter API execution
 * Uses OpenAI-compatible API format
 */
async function executeOpenRouter(config: {
  apiKey: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { apiKey, model, messages, systemPrompt, temperature, maxTokens, timeout, retries } = config;

  const systemMessages = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const allMessages = [...systemMessages, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
  };

  return fetchWithRetry(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeout,
    retries
  );
}

/**
 * Fireworks API execution
 * Uses OpenAI-compatible API format
 */
async function executeFireworks(config: {
  apiKey: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { apiKey, model, messages, systemPrompt, temperature, maxTokens, timeout, retries } = config;

  const systemMessages = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const allMessages = [...systemMessages, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
  };

  return fetchWithRetry(
    "https://api.fireworks.ai/inference/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeout,
    retries
  );
}

/**
 * Together API execution
 * Uses OpenAI-compatible API format
 */
async function executeTogether(config: {
  apiKey: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { apiKey, model, messages, systemPrompt, temperature, maxTokens, timeout, retries } = config;

  const systemMessages = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const allMessages = [...systemMessages, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
  };

  return fetchWithRetry(
    "https://api.together.xyz/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeout,
    retries
  );
}

/**
 * Groq API execution
 * Uses OpenAI-compatible API format
 */
async function executeGroq(config: {
  apiKey: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { apiKey, model, messages, systemPrompt, temperature, maxTokens, timeout, retries } = config;

  const systemMessages = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const allMessages = [...systemMessages, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
  };

  return fetchWithRetry(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeout,
    retries
  );
}

/**
 * Kimi (Moonshot) API execution
 */
async function executeKimi(config: {
  apiKey: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { apiKey, model, messages, systemPrompt, temperature, maxTokens, timeout, retries } = config;

  const systemMessages = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const allMessages = [...systemMessages, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
  };

  return fetchWithRetry(
    "https://api.moonshot.cn/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeout,
    retries
  );
}

/**
 * DeepSeek API execution
 */
async function executeDeepSeek(config: {
  apiKey: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { apiKey, model, messages, systemPrompt, temperature, maxTokens, timeout, retries } = config;

  const systemMessages = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const allMessages = [...systemMessages, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
  };

  return fetchWithRetry(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeout,
    retries
  );
}

/**
 * Quin API execution
 */
async function executeQuin(config: {
  apiKey: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { apiKey, model, messages, systemPrompt, temperature, maxTokens, timeout, retries } = config;

  const systemMessages = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const allMessages = [...systemMessages, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
  };

  return fetchWithRetry(
    "https://api.quin.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeout,
    retries
  );
}

/**
 * Complexity API execution
 */
async function executeComplexity(config: {
  apiKey: string;
  model: string;
  messages: any[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  retries?: number;
}): Promise<any> {
  const { apiKey, model, messages, systemPrompt, temperature, maxTokens, timeout, retries } = config;

  const systemMessages = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  const allMessages = [...systemMessages, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 4096,
  };

  return fetchWithRetry(
    "https://api.complexity.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeout,
    retries
  );
}

/**
 * Helper function to fetch with retry logic and timeout
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutSeconds: number = 300,
  maxRetries: number = 2
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData: unknown = await response.json().catch(() => ({ message: response.statusText }));
        const errorMessage =
          typeof errorData === "object" && errorData !== null
            ? (("message" in errorData && typeof (errorData as Record<string, unknown>).message === "string")
                ? (errorData as Record<string, string>).message
                : (("error" in errorData && typeof (errorData as Record<string, unknown>).error === "object"
                    && (errorData as Record<string, {message?: unknown}>).error?.message)
                  ? String((errorData as Record<string, {message?: unknown}>).error.message)
                  : JSON.stringify(errorData)))
            : JSON.stringify(errorData);
        throw new Error(`Provider API error: ${response.status} - ${errorMessage}`);
      }

      return response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on timeout or authentication errors
      if (lastError.message.includes("timeout") || lastError.message.includes("401") || lastError.message.includes("403")) {
        throw lastError;
      }

      // If this was the last attempt, throw
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Wait before retrying (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }

  throw lastError || new Error("Unknown error during fetch");
}
