// Single source of truth for the min-similarity confidence tier. The same rule
// (>= 0.9 high, >= 0.8 solid, else loose) was previously inlined in starmap.ts
// and re-implemented in the star-map consumer; both now anchor to this module
// (the consumer at the spec level - see star-map-odysseus/specs/data-contract.md).

export type Confidence = "high" | "solid" | "loose";

/** Lowest min-pairwise-similarity that still reads as a high-confidence cluster. */
export const CONFIDENCE_HIGH_MIN = 0.9;
/** Lowest min-pairwise-similarity that still reads as a solid cluster; below this is loose. */
export const CONFIDENCE_SOLID_MIN = 0.8;

/** Map a cluster's min pairwise similarity to its confidence tier. NaN -> loose. */
export function confidenceTier(minSimilarity: number): Confidence {
  if (minSimilarity >= CONFIDENCE_HIGH_MIN) return "high";
  if (minSimilarity >= CONFIDENCE_SOLID_MIN) return "solid";
  return "loose";
}
