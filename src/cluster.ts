import { selectCanonical } from "./canonical.js";
import { DEFAULT_SCORING_WEIGHTS } from "./config.js";
import { normalizeDescriptionQuality, normalizeDiffSize } from "./scorer.js";
import { cosineSimilarity, isZeroVector } from "./similarity.js";
import type { VectorStore } from "./store.js";
import type { Cluster, PRItem, ScoredPR, ScoreSignals } from "./types.js";

export { cosineSimilarity } from "./similarity.js";

export interface ClusterOptions {
  threshold: number;
  repo: string | string[];
}

/**
 * Score a single item into a ScoredPR using the shared quality weights (no
 * recency, so the pick is reproducible). Extracted so both the fuzzy clusterer
 * and the confirmed-duplicate finder (identity.ts) score members identically.
 */
export function scoreClusterItem(item: PRItem): ScoredPR {
  const hasTests = item.hasTests === true ? 1.0 : item.hasTests === false ? 0.0 : 0.5;
  const ciPassing = item.ciStatus === "success" ? 1 : item.ciStatus === "failure" ? 0 : 0.5;
  const descQuality = normalizeDescriptionQuality(item.body || "", (item.body || "").length);
  const reviewApprovals = Math.min(1.0, (item.reviewCount || 0) / 3);
  const hasDiff = item.additions != null && item.deletions != null;
  const diffSize = hasDiff ? normalizeDiffSize(item.additions || 0, item.deletions || 0) : 0.5;
  const authorHistory = 0.5; // no GitHub context available in clustering
  const signals: ScoreSignals = {
    hasTests,
    ciPassing,
    diffSize: hasDiff ? diffSize : -1,
    authorHistory,
    descriptionQuality: descQuality,
    reviewApprovals,
  };
  const w = DEFAULT_SCORING_WEIGHTS;
  const score =
    hasTests * w.has_tests +
    ciPassing * w.ci_passing +
    diffSize * w.diff_size_penalty +
    descQuality * w.description_quality +
    reviewApprovals * w.review_approvals +
    authorHistory * w.author_history;
  return { ...item, score, signals } as ScoredPR;
}

export function findDuplicateClusters(store: VectorStore, items: PRItem[], opts: ClusterOptions): Cluster[] {
  const repos = Array.isArray(opts.repo) ? opts.repo : [opts.repo];
  const allEmbeddings = repos.length === 1 ? store.getAllEmbeddings(repos[0]) : store.getAllEmbeddingsMulti(repos);

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
    itemMap.set(`${item.repo}:${item.type}:${item.number}`, item);
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
      for (const { id: candidateId } of candidates) {
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

  // Phase 1: BFS to find connected components
  const rawComponents: string[][] = [];
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

    if (component.length >= 2) rawComponents.push(component);
  }

  // Phase 2: Centroid refinement — eject items that aren't similar to the cluster centroid.
  // This breaks apart BFS mega-clusters where transitive chaining grouped unrelated items.
  const refinedComponents: string[][] = [];
  for (const component of rawComponents) {
    if (component.length <= 3) {
      // Small clusters don't need refinement
      refinedComponents.push(component);
      continue;
    }

    // Compute centroid (mean embedding)
    const dims = embeddings.get(component[0])!.length;
    const centroid = new Float32Array(dims);
    for (const cid of component) {
      const emb = embeddings.get(cid)!;
      for (let d = 0; d < dims; d++) centroid[d] += emb[d];
    }
    for (let d = 0; d < dims; d++) centroid[d] /= component.length;

    // Keep items above threshold similarity to centroid
    const kept: string[] = [];
    const ejected: string[] = [];
    for (const cid of component) {
      const sim = cosineSimilarity(embeddings.get(cid)!, centroid);
      if (sim >= opts.threshold) {
        kept.push(cid);
      } else {
        ejected.push(cid);
      }
    }

    // Re-absorb ejected items that still have a direct >= threshold edge to a
    // kept member. They are genuine duplicates pulling the centroid off-center,
    // not chain outliers, and dropping them is how legitimate members vanished
    // (e.g. issue #5297). Edges are checked against the original kept core so a
    // re-absorbed item can't cascade in more.
    const originalKept = [...kept];
    const trulyEjected: string[] = [];
    for (const eid of ejected) {
      const emb = embeddings.get(eid)!;
      const linkedToKept = originalKept.some((kid) => cosineSimilarity(emb, embeddings.get(kid)!) >= opts.threshold);
      if (linkedToKept) {
        kept.push(eid);
      } else {
        trulyEjected.push(eid);
      }
    }

    if (kept.length >= 2) {
      refinedComponents.push(kept);
    }

    // Re-cluster the remaining chain-outlier items among themselves.
    if (trulyEjected.length >= 2) {
      const ejectedAdj = new Map<string, Set<string>>();
      for (let i = 0; i < trulyEjected.length; i++) {
        for (let j = i + 1; j < trulyEjected.length; j++) {
          const sim = cosineSimilarity(embeddings.get(trulyEjected[i])!, embeddings.get(trulyEjected[j])!);
          if (sim >= opts.threshold) {
            if (!ejectedAdj.has(trulyEjected[i])) ejectedAdj.set(trulyEjected[i], new Set());
            if (!ejectedAdj.has(trulyEjected[j])) ejectedAdj.set(trulyEjected[j], new Set());
            ejectedAdj.get(trulyEjected[i])!.add(trulyEjected[j]);
            ejectedAdj.get(trulyEjected[j])!.add(trulyEjected[i]);
          }
        }
      }
      // BFS on the chain-outlier items
      const ejVisited = new Set<string>();
      for (const eid of trulyEjected) {
        if (ejVisited.has(eid) || !ejectedAdj.has(eid)) continue;
        const subComp: string[] = [];
        const q = [eid];
        while (q.length > 0) {
          const cur = q.shift()!;
          if (ejVisited.has(cur)) continue;
          ejVisited.add(cur);
          subComp.push(cur);
          for (const nb of ejectedAdj.get(cur) || []) {
            if (!ejVisited.has(nb)) q.push(nb);
          }
        }
        if (subComp.length >= 2) refinedComponents.push(subComp);
      }
    }
  }

  // Phase 3: Score and build cluster objects
  for (const component of refinedComponents) {
    if (component.length < 2) continue;

    const clusterItems: ScoredPR[] = component
      .map((cid) => {
        const item = itemMap.get(cid);
        return item ? scoreClusterItem(item) : null;
      })
      .filter((x): x is ScoredPR => x !== null)
      .sort((a, b) => b.score - a.score);

    if (clusterItems.length < 2) continue;

    // Exact avg + min pairwise similarity over ALL pairs. Deterministic by
    // construction: a sampled min is not the true min, and a sampled avg drifts
    // per run, which would flip the high/solid/loose confidence tier when a
    // maintainer re-runs. O(n^2) per cluster is fine — components are bounded by
    // the centroid-refinement pass above.
    let totalSim = 0,
      pairs = 0,
      minSim = 1;
    for (let i = 0; i < component.length; i++) {
      const embA = embeddings.get(component[i])!;
      for (let j = i + 1; j < component.length; j++) {
        const sim = cosineSimilarity(embA, embeddings.get(component[j])!);
        totalSim += sim;
        if (sim < minSim) minSim = sim;
        pairs++;
      }
    }

    clusters.push({
      id: 0, // reassigned below
      items: clusterItems,
      // Canonical via the shared selector (issue-majority -> earliest report,
      // PR-majority -> highest score); clusterItems stays score-sorted for display.
      bestPick: selectCanonical(clusterItems),
      avgSimilarity: pairs > 0 ? totalSim / pairs : 0,
      minSimilarity: pairs > 0 ? minSim : 0,
      theme: clusterItems[0].title,
    });
  }

  // Sort by size descending, then assign sequential IDs
  // Deterministic order: size desc, then by the cluster's lexically-lowest
  // (repo, number) so equal-size clusters always get the same ids regardless of
  // discovery/iteration order.
  const clusterRef = (c: Cluster) => {
    let best = c.items[0];
    for (const it of c.items) {
      if (it.repo < best.repo || (it.repo === best.repo && it.number < best.number)) best = it;
    }
    return best;
  };
  clusters.sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    const ka = clusterRef(a);
    const kb = clusterRef(b);
    if (ka.repo !== kb.repo) return ka.repo < kb.repo ? -1 : 1;
    return ka.number - kb.number;
  });
  clusters.forEach((c, i) => {
    c.id = i + 1;
  });

  return clusters;
}
