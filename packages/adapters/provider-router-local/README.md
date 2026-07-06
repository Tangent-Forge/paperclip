# Provider Router Local Adapter

Transparent multi-provider LLM routing adapter for Paperclip. This adapter replaces the opaque 611-model discovery of OpenCode with explicit, provider-scoped model selection.

## Why This Adapter

The OpenCode adapter discovers 611 models across all configured providers, but selections often fail because:
- You need to have ALL provider API keys configured to see all models
- Selecting a model might fail silently if that provider's key isn't set
- No clear visibility into which provider a model comes from

The Provider Router adapter solves this by:
- **Transparent provider selection**: Choose the provider first, then pick from that provider's models
- **Upfront validation**: Check API key exists before routing
- **Clear scoping**: See exactly which models are available for each provider
- **Graceful failures**: Get immediate feedback if a provider isn't configured

## Supported Providers

| Provider | Label | Models | Auth |
|----------|-------|--------|------|
| OpenRouter | OpenRouter | Claude, GPT-4, Gemini, Llama | `OPENROUTER_API_KEY` |
| Fireworks | Fireworks AI | Claude 3.5, Llama 3 | `FIREWORKS_API_KEY` |
| Together | Together AI | Llama 3, Mistral, Nous Hermes | `TOGETHER_API_KEY` |
| Groq | Groq | Mixtral, Llama 3 | `GROQ_API_KEY` |
| Kimi | Kimi (Moonshot AI) | Moonshot v1 (8K, 32K, 128K) | `KIMI_API_KEY` |
| DeepSeek | DeepSeek | DeepSeek Chat, DeepSeek Coder | `DEEPSEEK_API_KEY` |
| Quin | Quin | Quin v1 | `QUIN_API_KEY` |
| Complexity | Complexity | Complexity v1 | `COMPLEXITY_API_KEY` |

## Configuration

### Basic Configuration

```json
{
  "provider": "openrouter",
  "model": "openrouter/anthropic/claude-sonnet-4"
}
```

### Advanced Configuration

```json
{
  "provider": "groq",
  "model": "groq/llama-3-70b-8192",
  "fallbackProviders": ["together", "openrouter"],
  "timeout": 60,
  "retries": 2,
  "cwd": "/path/to/work",
  "instructionsFilePath": "/path/to/instructions.md",
  "promptTemplate": "custom prompt template"
}
```

### Environment Variables

All provider authentication keys must be set as environment variables:

```bash
# OpenRouter
export OPENROUTER_API_KEY=sk-or-v1-...

# Fireworks
export FIREWORKS_API_KEY=fw_...

# Together
export TOGETHER_API_KEY=tgp_v1_...

# Groq
export GROQ_API_KEY=gsk_...

# Kimi (Moonshot)
export KIMI_API_KEY=sk-...

# DeepSeek
export DEEPSEEK_API_KEY=sk-...

# Quin
export QUIN_API_KEY=...

# Complexity
export COMPLEXITY_API_KEY=...
```

## How It Works

1. **Provider Selection**: User selects a provider (e.g., "Groq")
2. **API Key Validation**: Adapter checks if `GROQ_API_KEY` is set
3. **Model Selection**: User picks from Groq's available models
4. **Routing**: Request is sent to Groq's API endpoint with proper authentication
5. **Fallback** (optional): If fallbackProviders configured, tries next provider on failure

## Model Profiles (Presets)

Three curated profiles are included:

- **Recommended**: Claude Sonnet 4 via OpenRouter (fast, capable, widely available)
- **Fast**: Llama 3 70B via Groq (fastest inference engine)
- **Budget**: Llama 3 8B via Together (lowest cost)

## API Error Handling

The adapter includes intelligent retry logic:
- **Retries**: Exponential backoff (2^n seconds between attempts)
- **No-Retry Errors**: Auth failures (401/403), timeouts
- **Retry Errors**: Network timeouts, rate limiting, temporary failures

Default: 2 retries, 300 second timeout

## Architecture

### src/index.ts
- Provider definitions with models, auth keys, documentation links
- Model profiles (presets)
- Configuration documentation

### src/server/models.ts
- `getProviderModels()`: Get available models for a provider (validates API key)
- `validateProviderModel()`: Check model exists for provider
- `getConfiguredProviders()`: List providers with API keys set
- `getAllConfiguredModels()`: All models across configured providers

### src/server/execute.ts
- `executeWithProvider()`: Main entry point for routing requests
- Provider-specific executors for each supported provider
- Retry logic with exponential backoff

### src/ui/build-config.ts
- Configuration validation and parsing
- Environment variable binding support
- Config JSON serialization

## Usage in Paperclip

Update an agent's adapter configuration:

```javascript
const agent = {
  id: "your-agent-id",
  name: "Multi-Provider Agent",
  adapter_config: {
    provider: "groq",
    model: "groq/llama-3-70b-8192",
    fallbackProviders: ["together", "openrouter"],
    timeout: 60,
    retries: 2
  }
};
```

Or use a preset profile:

```javascript
const agent = {
  adapter_config: {
    provider: "openrouter",
    model: "openrouter/anthropic/claude-sonnet-4"
  }
};
```

## Testing

Each provider implementation follows OpenAI's compatible API format, making testing and swapping providers straightforward. To test a specific provider:

```javascript
import { executeWithProvider } from "@paperclipai/provider-router-local/server";

await executeWithProvider({
  provider: "groq",
  model: "groq/llama-3-70b-8192",
  messages: [{ role: "user", content: "Hello!" }],
  maxTokens: 1024
});
```
