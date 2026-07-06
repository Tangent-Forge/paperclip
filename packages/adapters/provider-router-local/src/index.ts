import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "provider_router_local";
export const label = "Multi-Provider Router (local)";

/**
 * Provider definitions with their available models and authentication methods.
 * Each provider has:
 * - id: unique provider identifier
 * - label: human-readable name shown in menus
 * - envKey: environment variable containing the API key
 * - models: list of available models for this provider
 * - baseUrl: optional custom API endpoint
 */
export const providers = [
  {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    models: [
      { id: "openrouter/anthropic/claude-opus-4", label: "Claude Opus 4 (OpenRouter)" },
      { id: "openrouter/anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (OpenRouter)" },
      { id: "openrouter/openai/gpt-4-turbo", label: "GPT-4 Turbo (OpenRouter)" },
      { id: "openrouter/openai/gpt-4o", label: "GPT-4o (OpenRouter)" },
      { id: "openrouter/google/gemini-pro", label: "Gemini Pro (OpenRouter)" },
      { id: "openrouter/meta-llama/llama-2-70b", label: "Llama 2 70B (OpenRouter)" },
    ],
    docs: "https://openrouter.ai/docs",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    envKey: "FIREWORKS_API_KEY",
    models: [
      { id: "fireworks/accounts/fireworks/models/claude-3-5-sonnet", label: "Claude 3.5 Sonnet (Fireworks)" },
      { id: "fireworks/accounts/fireworks/models/llama-v3-8b", label: "Llama 3 8B (Fireworks)" },
      { id: "fireworks/accounts/fireworks/models/llama-v3-70b", label: "Llama 3 70B (Fireworks)" },
    ],
    docs: "https://docs.fireworks.ai",
  },
  {
    id: "together",
    label: "Together AI",
    envKey: "TOGETHER_API_KEY",
    models: [
      { id: "together/meta-llama/Llama-3-8b-chat-hf", label: "Llama 3 8B Chat (Together)" },
      { id: "together/meta-llama/Llama-3-70b-chat-hf", label: "Llama 3 70B Chat (Together)" },
      { id: "together/mistralai/Mistral-7B-Instruct-v0.1", label: "Mistral 7B (Together)" },
      { id: "together/NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO", label: "Nous Hermes 2 (Together)" },
    ],
    docs: "https://docs.together.ai",
  },
  {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    models: [
      { id: "groq/mixtral-8x7b-32768", label: "Mixtral 8x7B (Groq)" },
      { id: "groq/llama-3-70b-8192", label: "Llama 3 70B (Groq)" },
      { id: "groq/llama-3-8b-8192", label: "Llama 3 8B (Groq)" },
    ],
    docs: "https://console.groq.com",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot AI)",
    envKey: "KIMI_API_KEY",
    models: [
      { id: "kimi/moonshot-v1-8k", label: "Moonshot v1 8K (Kimi)" },
      { id: "kimi/moonshot-v1-32k", label: "Moonshot v1 32K (Kimi)" },
      { id: "kimi/moonshot-v1-128k", label: "Moonshot v1 128K (Kimi)" },
    ],
    docs: "https://platform.moonshot.cn",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek/deepseek-coder", label: "DeepSeek Coder" },
    ],
    docs: "https://platform.deepseek.com",
  },
  {
    id: "quin",
    label: "Quin",
    envKey: "QUIN_API_KEY",
    models: [
      { id: "quin/quin-v1", label: "Quin v1" },
    ],
    docs: "https://quin.ai",
  },
  {
    id: "complexity",
    label: "Complexity",
    envKey: "COMPLEXITY_API_KEY",
    models: [
      { id: "complexity/complexity-v1", label: "Complexity v1" },
    ],
    docs: "https://complexity.ai",
  },
];

export const models = providers.flatMap((p) => p.models);

// Model profiles — currently only support the "cheap" key type per framework constraints
// The actual model selection happens through provider + model fields in adapter_config
export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Budget",
    description: "Llama 3 8B via Together (lowest cost, good for prototyping)",
    adapterConfig: {
      provider: "together",
      model: "together/meta-llama/Llama-3-8b-chat-hf",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# provider_router_local agent configuration

Adapter: provider_router_local

Use when:
- You have multiple LLM provider API keys and want to switch between them transparently
- You want clear visibility into which provider/model you're using
- You need fallback routing across multiple providers
- You want provider-specific model selection without aggregation

Don't use when:
- You only use a single LLM provider (use the provider's native adapter instead)
- You need OpenCode's unified model discovery across all providers

Core fields:
- provider (string, required): one of: openrouter, fireworks, together, groq, kimi, deepseek, quin, complexity
- model (string, required): full model id including provider prefix (e.g. openrouter/anthropic/claude-sonnet-4)
- fallbackProviders (string[], optional): array of provider ids to try in order if primary provider fails
- timeout (number, optional): request timeout in seconds (default: 300)
- retries (number, optional): number of retry attempts (default: 2)
- env (object, optional): KEY=VALUE environment variables

Optional:
- cwd (string, optional): default working directory
- instructionsFilePath (string, optional): path to instructions markdown
- promptTemplate (string, optional): custom prompt template

Notes:
- Each provider requires its API key in the environment (OPENROUTER_API_KEY, FIREWORKS_API_KEY, etc.)
- Models are prefixed with provider name for clarity (e.g., openrouter/anthropic/claude-sonnet-4)
- The adapter validates that the selected provider's API key is configured before executing
- Fallback providers allow graceful degradation if a provider is unavailable or rate-limited
`;
