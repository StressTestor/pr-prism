import { type Confidence, confidenceTier } from "./confidence.js";
import type { Cluster } from "./types.js";

// Machine-readable "star map" contract: a stable JSON shape for downstream
// visualizers/consumers that today scrape the Markdown report. Exposes the
// signals the Markdown hides (minSimilarity, confidence tier, issue/PR split,
// contested picks) plus a (repo, number) join key.

export const STARMAP_SCHEMA_VERSION = 1;

// Top-two score gap below which the best pick is treated as a coin flip.
const TIE_MARGIN = 0.05;

// Confidence tiering lives in its own module now; re-exported so existing
// importers of `./starmap.js` (cli.ts, starmap.test.ts, the payload types) keep
// working unchanged.
export { confidenceTier, type Confidence };

export interface StarmapItemRef {
  repo: string;
  number: number;
  type: "pr" | "issue";
  url: string;
  /** GitHub node id; present only when the scan fetched it. */
  nodeId?: string;
}

export interface StarmapItem extends StarmapItemRef {
  title: string;
  author: string;
  updatedAt: string;
  score: number;
}

export interface StarmapCluster {
  id: string;
  index: number;
  theme: string;
  size: number;
  avgSimilarity: number;
  minSimilarity: number;
  confidence: Confidence;
  canonical: StarmapItemRef;
  contested: boolean;
  runnerUpMargin: number | null;
  partition: { issues: StarmapItemRef[]; prs: StarmapItemRef[] };
  items: StarmapItem[];
}

export interface StarmapPayload {
  schemaVersion: number;
  repo: string;
  generatedAt: string;
  /** Embedding model the snapshot was built with. Similarity thresholds are not
   * portable across models, so consumers should only compare same-model runs. */
  embeddingModel: string;
  embeddingProvider: string;
  embeddingDimensions: number;
  /** provider:model:dims:textVersion — fully identifies the embedding space so
   * consumers can tell two snapshots apart without guessing from the model name. */
  embeddingConfigHash: string;
  threshold: number;
  totalItems: number;
  clusterCount: number;
  clusters: StarmapCluster[];
}

export interface StarmapMeta {
  repo: string;
  threshold: number;
  generatedAt: string;
  embeddingModel: string;
  embeddingProvider: string;
  embeddingDimensions: number;
  embeddingConfigHash: string;
}

function itemUrl(repo: string, type: "pr" | "issue", number: number): string {
  return `https://github.com/${repo}/${type === "pr" ? "pull" : "issues"}/${number}`;
}

function ref(item: { repo: string; number: number; type: "pr" | "issue"; nodeId?: string }): StarmapItemRef {
  const r: StarmapItemRef = {
    repo: item.repo,
    number: item.number,
    type: item.type,
    url: itemUrl(item.repo, item.type, item.number),
  };
  if (item.nodeId) r.nodeId = item.nodeId;
  return r;
}

export function buildStarmapPayload(clusters: Cluster[], meta: StarmapMeta): StarmapPayload {
  const outClusters: StarmapCluster[] = clusters.map((c) => {
    const ranked = [...c.items].sort((a, b) => b.score - a.score);
    const runnerUpMargin = ranked.length >= 2 ? ranked[0].score - ranked[1].score : null;
    const items: StarmapItem[] = ranked.map((it) => ({
      ...ref(it),
      title: it.title,
      author: it.author,
      updatedAt: it.updatedAt,
      score: it.score,
    }));
    return {
      id: `t${meta.threshold.toString().replace(".", "")}-cluster-${c.id}`,
      index: c.id,
      theme: c.theme,
      size: c.items.length,
      avgSimilarity: c.avgSimilarity,
      minSimilarity: c.minSimilarity,
      confidence: confidenceTier(c.minSimilarity),
      canonical: ref(c.bestPick),
      contested: runnerUpMargin != null && runnerUpMargin < TIE_MARGIN,
      runnerUpMargin,
      partition: {
        issues: items.filter((i) => i.type === "issue").map(ref),
        prs: items.filter((i) => i.type === "pr").map(ref),
      },
      items,
    };
  });

  return {
    schemaVersion: STARMAP_SCHEMA_VERSION,
    repo: meta.repo,
    generatedAt: meta.generatedAt,
    embeddingModel: meta.embeddingModel,
    embeddingProvider: meta.embeddingProvider,
    embeddingDimensions: meta.embeddingDimensions,
    embeddingConfigHash: meta.embeddingConfigHash,
    threshold: meta.threshold,
    totalItems: clusters.reduce((sum, c) => sum + c.items.length, 0),
    clusterCount: clusters.length,
    clusters: outClusters,
  };
}
