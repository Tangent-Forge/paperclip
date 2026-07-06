import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import { getProviderModels, getConfiguredProviders } from "./models.js";

/**
 * Test environment for provider-router-local adapter.
 * Verifies that the configured provider has API keys set and models available.
 */
export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  let hasError = false;
  let hasWarning = false;

  try {
    // Check 1: Verify at least one provider is configured
    const configuredProviders = await getConfiguredProviders();
    if (configuredProviders.length === 0) {
      checks.push({
        code: "providers-configured",
        level: "error",
        message: "No providers configured",
        detail: "Please set API keys for at least one provider.",
      });
      hasError = true;
    } else {
      checks.push({
        code: "providers-configured",
        level: "info",
        message: "Providers Configured",
        detail: `${configuredProviders.length} provider(s) configured`,
      });

      // Check 2: Verify selected provider has API key
      const config = ctx.config as Record<string, unknown>;
      const providerId = typeof config.provider === "string" ? config.provider : null;

      if (!providerId) {
        checks.push({
          code: "provider-selected",
          level: "error",
          message: "No provider selected",
          detail: "Provider must be selected in adapter configuration",
        });
        hasError = true;
      } else {
        const providerExists = configuredProviders.some((p) => p.id === providerId);
        if (!providerExists) {
          checks.push({
            code: "provider-selected",
            level: "error",
            message: "Selected provider not configured",
            detail: `Provider "${providerId}" is not configured`,
          });
          hasError = true;
        } else {
          checks.push({
            code: "provider-selected",
            level: "info",
            message: "Provider Selected",
            detail: `Provider "${providerId}" is configured`,
          });

          // Check 3: Verify provider has models
          try {
            const models = await getProviderModels(providerId);
            if (models.length === 0) {
              checks.push({
                code: "provider-models",
                level: "warn",
                message: "No models available",
                detail: `No models available for provider "${providerId}"`,
              });
              hasWarning = true;
            } else {
              checks.push({
                code: "provider-models",
                level: "info",
                message: "Provider Models Available",
                detail: `${models.length} model(s) available`,
              });
            }
          } catch (err) {
            checks.push({
              code: "provider-models",
              level: "error",
              message: "Failed to fetch models",
              detail: err instanceof Error ? err.message : "Unknown error",
            });
            hasError = true;
          }
        }
      }
    }
  } catch (err) {
    checks.push({
      code: "environment-test",
      level: "error",
      message: "Environment test failed",
      detail: err instanceof Error ? err.message : "Unknown error",
    });
    hasError = true;
  }

  return {
    adapterType: ctx.adapterType,
    status: hasError ? "fail" : hasWarning ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
