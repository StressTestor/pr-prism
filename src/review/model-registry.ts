/**
 * Review Model Registry — configurable tier definitions for Featherless provider.
 * All settings are validated and configurable. Never silently substitutes a model.
 */

export type ReviewTier = "light" | "intermediate" | "complex";

export interface ModelTierConfig {
  tier: ReviewTier;
  modelId: string;
  provider: "featherless" | "openai" | "anthropic" | "ollama";
  contextTokens: number; // max context window
  maxOutputTokens: number; // initial output token budget (NOT equal to context window)
  concurrencyUnits: number; // units consumed per request
  maxConcurrentPerAccount: number; // max parallel requests for this tier per account
  // For complex tier: complex requests must not overlap with another request on same account
  exclusivePerAccount: boolean;
  // GLM-5.3-Flash reasoning effort (null = not applicable)
  reasoningEffort: "low" | "high" | null;
  // Price per million tokens (informational)
  pricePer1MInputTokens?: number;
  pricePer1MOutputTokens?: number;
}

export const DEFAULT_FEATHERLESS_TIERS: Record<ReviewTier, ModelTierConfig> = {
  light: {
    tier: "light",
    modelId: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    provider: "featherless",
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
    concurrencyUnits: 1,
    maxConcurrentPerAccount: 2,
    exclusivePerAccount: false,
    reasoningEffort: null,
  },
  intermediate: {
    tier: "intermediate",
    modelId: "zai-org/GLM-4.7-Flash",
    provider: "featherless",
    contextTokens: 202_752,
    maxOutputTokens: 8_192,
    concurrencyUnits: 2,
    maxConcurrentPerAccount: 2,
    exclusivePerAccount: false,
    reasoningEffort: null,
  },
  complex: {
    tier: "complex",
    modelId: "zai-org/GLM-5.3-Flash",
    provider: "featherless",
    contextTokens: 262_144,
    maxOutputTokens: 12_288,
    concurrencyUnits: 4,
    maxConcurrentPerAccount: 1,
    exclusivePerAccount: true, // Complex must not overlap on same account
    reasoningEffort: "low", // Default: prefer complete grounded answers over hidden reasoning
  },
};

// Deep copy so callers can override
export function getDefaultTierConfigs(): Record<ReviewTier, ModelTierConfig> {
  return JSON.parse(JSON.stringify(DEFAULT_FEATHERLESS_TIERS));
}

export function getTierConfig(
  tier: ReviewTier,
  overrides?: Partial<Record<ReviewTier, Partial<ModelTierConfig>>>,
): ModelTierConfig {
  const base = DEFAULT_FEATHERLESS_TIERS[tier];
  if (!overrides || !overrides[tier]) return { ...base };
  return { ...base, ...overrides[tier] };
}

export function resolveTierFromModelId(modelId: string): ReviewTier | null {
  for (const [tier, config] of Object.entries(DEFAULT_FEATHERLESS_TIERS)) {
    if (config.modelId === modelId) return tier as ReviewTier;
  }
  return null;
}

/**
 * Validate that a model is actually available by querying provider metadata.
 * Returns null if available, or an error message if not.
 */
export async function validateModelAvailability(
  modelId: string,
  apiKey: string,
  baseUrl: string = "https://api.featherless.ai/v1",
): Promise<{ available: boolean; error?: string }> {
  try {
    const resp = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) return { available: true };
    if (resp.status === 404) return { available: false, error: `Model ${modelId} not found on provider` };
    return { available: false, error: `Model check failed: HTTP ${resp.status}` };
  } catch (err: any) {
    return { available: false, error: `Model check fetch error: ${err?.message}` };
  }
}
