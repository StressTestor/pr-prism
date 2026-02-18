import { cosineSimilarity, isZeroVector } from "./similarity.js";
import type { VectorStore } from "./store.js";
import type { Cluster, PRItem, ScoredPR, ScoreSignals } from "./types.js";

export { cosineSimilarity } from "./similarity.js";

function recencyFactor(updatedAt: string): number {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return 0.5 ** (ageDays / 30);
}

export interface ClusterOptions {
  threshold: number;
  repo: string;
}

export function findDuplicateClusters(store: VectorStore, items: PRItem[], opts: ClusterOptions): Cluster[] {
  const allEmbeddings = store.getAllEmbeddings(opts.repo);

  // Filter out zero vectors (failed embeddings)
  const embeddings = new Map<string, Float32Array>();
  let zeroCount = 0;
  for (const [id, emb] of allEmbeddings) {
    if (isZeroVector(emb)) {
      zeroCount++;
    } else {
      embeddings.set(id, emb);
    }
  }
  if (zeroCount > 0) {
    console.warn(`warning: ${zeroCount} items have zero-vector embeddings and were excluded from clustering`);
  }

  const itemMap = new Map<string, PRItem>();
  for (const item of items) {
    itemMap.set(`${opts.repo}:${item.type}:${item.number}`, item);
  }

  const ids = [...embeddings.keys()];
  const adjacency = new Map<string, Set<string>>();

  // For large datasets, use ANN pre-filtering via store.search() to reduce candidate pairs
  // For smaller datasets (< 5000), brute force is fast enough
  const useANN = ids.length >= 5000;

  if (useANN) {
    // ANN candidate generation: for each item, find top-K nearest neighbors
    // then verify with exact cosine similarity
    const K = 50; // candidates per item
    for (const id of ids) {
      const emb = embeddings.get(id)!;
      const candidates = store.search(emb, K, opts.threshold);
      for (const { id: candidateId, distance } of candidates) {
        if (candidateId === id) continue;
        if (!embeddings.has(candidateId)) continue;
        // Verify with exact cosine similarity
        const sim = cosineSimilarity(emb, embeddings.get(candidateId)!);
        if (sim >= opts.threshold) {
          if (!adjacency.has(id)) adjacency.set(id, new Set());
          if (!adjacency.has(candidateId)) adjacency.set(candidateId, new Set());
          adjacency.get(id)?.add(candidateId);
          adjacency.get(candidateId)?.add(id);
        }
      }
    }
  } else {
    // Brute force O(n²) — fine for < 5000 items
    for (let i = 0; i < ids.length; i++) {
      const embA = embeddings.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const embB = embeddings.get(ids[j])!;
        const sim = cosineSimilarity(embA, embB);
        if (sim >= opts.threshold) {
          if (!adjacency.has(ids[i])) adjacency.set(ids[i], new Set());
          if (!adjacency.has(ids[j])) adjacency.set(ids[j], new Set());
          adjacency.get(ids[i])?.add(ids[j]);
          adjacency.get(ids[j])?.add(ids[i]);
        }
      }
    }
  }

  const visited = new Set<string>();
  const clusters: Cluster[] = [];

  for (const id of ids) {
    if (visited.has(id) || !adjacency.has(id)) continue;

    const component: string[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }

    if (component.length < 2) continue;

    const clusterItems: ScoredPR[] = component
      .map((cid) => {
        const item = itemMap.get(cid);
        if (!item) return null;
        const recency = recencyFactor(item.updatedAt);
        const signals: ScoreSignals = {
          hasTests: 0,
          ciPassing: 0,
          diffSize: 0,
          authorHistory: 0,
          descriptionQuality: Math.min(1, (item.body?.length || 0) / 500),
          reviewApprovals: 0,
          recency,
        };
        return { ...item, score: recency * signals.descriptionQuality, signals } as ScoredPR;
      })
      .filter((x): x is ScoredPR => x !== null)
      .sort((a, b) => b.score - a.score);

    if (clusterItems.length < 2) continue;

    let totalSim = 0,
      pairs = 0;
    for (let i = 0; i < component.length; i++) {
      for (let j = i + 1; j < component.length; j++) {
        const embA = embeddings.get(component[i])!;
        const embB = embeddings.get(component[j])!;
        totalSim += cosineSimilarity(embA, embB);
        pairs++;
      }
    }

    clusters.push({
      id: 0, // reassigned below
      items: clusterItems,
      bestPick: clusterItems[0],
      avgSimilarity: pairs > 0 ? totalSim / pairs : 0,
      theme: clusterItems[0].title,
    });
  }

  // Sort by size descending, then assign sequential IDs
  clusters.sort((a, b) => b.items.length - a.items.length);
  clusters.forEach((c, i) => {
    c.id = i + 1;
  });

  return clusters;
}
