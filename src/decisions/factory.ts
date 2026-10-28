import { DisabledDecisionProvider } from "./disabled-provider.js";
import { JevDecisionProvider, type JevProviderConfig } from "./jev-provider.js";
import { MockDecisionProvider, type MockProviderOptions } from "./mock-provider.js";
import type { DecisionConfig, DecisionProvider } from "./types.js";

/**
 * Creates a DecisionProvider according to configuration.
 *
 * Enforces the explicit activation contract:
 * - Jev provider instantiation strictly requires enabled === true.
 * - When enabled is omitted or false, returns DisabledDecisionProvider without requiring credentials.
 * - Offline mock usage is preserved when explicitly requested via provider: "mock" (unless enabled === false).
 * - Zero external requests or paid inference calls are made when disabled.
 */
export function createDecisionProvider(
  config: DecisionConfig & {
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    mockOptions?: MockProviderOptions;
  } = {},
): DecisionProvider {
  // Offline mock usage is preserved when explicitly requested (unless explicitly disabled)
  if (config.provider === "mock") {
    if (config.enabled === false) {
      return new DisabledDecisionProvider();
    }
    return new MockDecisionProvider({
      model: config.model,
      ...config.mockOptions,
    });
  }

  // Jev provider instantiation strictly requires enabled === true
  if (config.enabled !== true) {
    return new DisabledDecisionProvider();
  }

  const provider = config.provider || "jev";

  if (provider === "jev") {
    const jevConfig: JevProviderConfig = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultModel: config.model,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
    };
    return new JevDecisionProvider(jevConfig);
  }

  throw new Error(`Unknown decision provider: ${provider}. Supported providers are 'jev' and 'mock'.`);
}
