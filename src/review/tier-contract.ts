import { DEFAULT_FEATHERLESS_TIERS } from "./model-registry.js";

export const REVIEW_TIER_CONTRACT = {
  schemaVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  tiers: Object.values(DEFAULT_FEATHERLESS_TIERS).map((t) => ({
    tier: t.tier,
    modelId: t.modelId,
    provider: t.provider,
    contextTokens: t.contextTokens,
    maxOutputTokens: t.maxOutputTokens,
    concurrencyUnits: t.concurrencyUnits,
    maxConcurrentPerAccount: t.maxConcurrentPerAccount,
    exclusivePerAccount: t.exclusivePerAccount,
  })),
  concurrencyPolicy: {
    maxAccountsSupported: 5,
    defaultMaxConcurrentPerAccount: 1,
    lightMaxConcurrent: 2,
    intermediateMaxConcurrent: 2,
    complexMaxConcurrent: 1,
    complexIsExclusive: true,
  },
} as const;

export function exportTierContractJSON(): string {
  return JSON.stringify(REVIEW_TIER_CONTRACT, null, 2);
}
