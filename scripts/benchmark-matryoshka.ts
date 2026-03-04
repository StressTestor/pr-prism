#!/usr/bin/env npx tsx
/**
 * Matryoshka Dimension Benchmark
 *
 * Compares dupe detection quality at 1024 dims vs 512 dims on a real corpus.
 * Uses qwen3-embedding:0.6b via Ollama (native 1024 dims, Matryoshka-capable).
 *
 * Usage: npx tsx scripts/benchmark-matryoshka.ts
 * Requires: Ollama running with qwen3-embedding:0.6b, GITHUB_TOKEN in env
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { findDuplicateClusters } from "../src/cluster.js";
import { createEmbeddingProvider, prepareEmbeddingText } from "../src/embeddings.js";
import { GitHubClient } from "../src/github.js";
import { VectorStore } from "../src/store.js";
import type { PRItem } from "../src/types.js";

const REPO_OWNER = "openclaw";
const REPO_NAME = "openclaw";
const THRESHOLD = 0.85;
const MAX_ITEMS = 2000; // cap for benchmark speed
const BATCH_SIZE = 50;

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    // Try gh CLI token
    const { execSync } = await import("node:child_process");
    try {
      const ghToken = execSync("gh auth token", { encoding: "utf-8" }).trim();
      if (ghToken) process.env.GITHUB_TOKEN = ghToken;
    } catch {
      console.error("No GITHUB_TOKEN found. Set it or login with `gh auth login`");
      process.exit(1);
    }
  }

  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN!;
  const github = new GitHubClient(ghToken, REPO_OWNER, REPO_NAME);
  const repoFull = `${REPO_OWNER}/${REPO_NAME}`;

  // Create benchmark data dir
  const benchDir = resolve(process.cwd(), "data", "benchmark");
  mkdirSync(benchDir, { recursive: true });

  console.log(`\n=== Matryoshka Dimension Benchmark ===`);
  console.log(`Repo: ${repoFull}`);
  console.log(`Threshold: ${THRESHOLD}`);
  console.log(`Max items: ${MAX_ITEMS}\n`);

  // 1. Fetch items
  console.log("Fetching PRs and issues...");
  const prs = await github.fetchPRsGraphQL({ maxItems: MAX_ITEMS, onProgress: (f, t) => process.stdout.write(`\r  PRs: ${f}/${t}`) });
  console.log(`\n  Got ${prs.length} PRs`);
  const issues = await github.fetchIssuesGraphQL({ maxItems: MAX_ITEMS - prs.length, onProgress: (f, t) => process.stdout.write(`\r  Issues: ${f}/${t}`) });
  console.log(`\n  Got ${issues.length} issues`);
  const allItems = [...prs, ...issues].slice(0, MAX_ITEMS);
  console.log(`  Total: ${allItems.length} items\n`);

  // 2. Create embedder (native 1024 dims)
  const embedder = await createEmbeddingProvider({
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
  });
  console.log(`Embedding model: qwen3-embedding:0.6b (${embedder.dimensions} native dims)\n`);

  // 3. Embed all items at full 1024 dims
  console.log("Embedding all items at 1024 dims...");
  const fullEmbeddings: Map<string, number[]> = new Map();
  let done = 0;
  for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
    const batch = allItems.slice(i, i + BATCH_SIZE);
    const texts = batch.map((item) => prepareEmbeddingText(item));
    const embeddings = await embedder.embedBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      const id = `${repoFull}:${batch[j].type}:${batch[j].number}`;
      fullEmbeddings.set(id, embeddings[j]);
    }
    done += batch.length;
    process.stdout.write(`\r  ${done}/${allItems.length}`);
  }
  console.log("\n");

  // 4. Run clustering at 1024 dims
  console.log("=== 1024 dims ===");
  const db1024Path = resolve(benchDir, "bench-1024.db");
  const store1024 = new VectorStore(db1024Path, 1024, "qwen3-embedding:0.6b");
  for (const item of allItems) {
    const id = `${repoFull}:${item.type}:${item.number}`;
    const emb = fullEmbeddings.get(id)!;
    store1024.upsert({
      id,
      type: item.type,
      number: item.number,
      repo: repoFull,
      title: item.title,
      bodySnippet: item.body.slice(0, 500),
      embedding: new Float32Array(emb),
      metadata: { author: item.author, state: item.state, labels: item.labels },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }

  const items1024 = store1024.getAllItems(repoFull) as unknown as PRItem[];
  const clusters1024 = findDuplicateClusters(store1024, items1024, { threshold: THRESHOLD, repo: repoFull });
  const clusterItems1024 = clusters1024.reduce((s, c) => s + c.items.length, 0);
  console.log(`  Clusters: ${clusters1024.length}`);
  console.log(`  Items in clusters: ${clusterItems1024}`);
  console.log(`  Avg cluster size: ${(clusterItems1024 / clusters1024.length).toFixed(1)}`);
  store1024.close();

  // 5. Run clustering at 512 dims (Matryoshka truncation)
  console.log("\n=== 512 dims (Matryoshka) ===");
  const db512Path = resolve(benchDir, "bench-512.db");
  const store512 = new VectorStore(db512Path, 512, "qwen3-embedding:0.6b");
  for (const item of allItems) {
    const id = `${repoFull}:${item.type}:${item.number}`;
    const fullEmb = fullEmbeddings.get(id)!;
    const truncated = fullEmb.slice(0, 512);
    store512.upsert({
      id,
      type: item.type,
      number: item.number,
      repo: repoFull,
      title: item.title,
      bodySnippet: item.body.slice(0, 500),
      embedding: new Float32Array(truncated),
      metadata: { author: item.author, state: item.state, labels: item.labels },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }

  const items512 = store512.getAllItems(repoFull) as unknown as PRItem[];
  const clusters512 = findDuplicateClusters(store512, items512, { threshold: THRESHOLD, repo: repoFull });
  const clusterItems512 = clusters512.reduce((s, c) => s + c.items.length, 0);
  console.log(`  Clusters: ${clusters512.length}`);
  console.log(`  Items in clusters: ${clusterItems512}`);
  console.log(`  Avg cluster size: ${(clusterItems512 / clusters512.length).toFixed(1)}`);
  store512.close();

  // 6. Compare results
  console.log("\n=== Comparison ===");
  console.log(`| Metric               | 1024 dims | 512 dims  | Delta   |`);
  console.log(`|----------------------|-----------|-----------|---------|`);
  console.log(`| Clusters             | ${String(clusters1024.length).padStart(9)} | ${String(clusters512.length).padStart(9)} | ${String(clusters512.length - clusters1024.length).padStart(7)} |`);
  console.log(`| Items in clusters    | ${String(clusterItems1024).padStart(9)} | ${String(clusterItems512).padStart(9)} | ${String(clusterItems512 - clusterItems1024).padStart(7)} |`);
  console.log(`| Avg cluster size     | ${(clusterItems1024 / clusters1024.length).toFixed(1).padStart(9)} | ${(clusterItems512 / clusters512.length).toFixed(1).padStart(9)} |         |`);

  // Cluster membership overlap (how many items appear in clusters in both runs)
  const clusterMembers1024 = new Set<number>();
  const clusterMembers512 = new Set<number>();
  for (const c of clusters1024) for (const i of c.items) clusterMembers1024.add(i.number);
  for (const c of clusters512) for (const i of c.items) clusterMembers512.add(i.number);

  const overlap = [...clusterMembers1024].filter((n) => clusterMembers512.has(n)).length;
  const union = new Set([...clusterMembers1024, ...clusterMembers512]).size;
  const jaccard = union > 0 ? overlap / union : 0;
  console.log(`| Membership overlap   | ${String(clusterMembers1024.size).padStart(9)} | ${String(clusterMembers512.size).padStart(9)} |         |`);
  console.log(`| Jaccard similarity   |           |           | ${(jaccard * 100).toFixed(1).padStart(5)}%  |`);

  // Spot-check: compare top 20 clusters
  console.log("\n=== Top 20 Cluster Spot-Check ===");
  console.log("(Comparing best-pick agreement between 1024 and 512 dims)\n");
  const bestPicks1024 = new Map(clusters1024.slice(0, 20).map((c) => [c.theme.slice(0, 40), c.bestPick.number]));
  let agreements = 0;
  for (const c512 of clusters512.slice(0, 20)) {
    const theme = c512.theme.slice(0, 40);
    const pick1024 = bestPicks1024.get(theme);
    if (pick1024 === c512.bestPick.number) agreements++;
  }
  console.log(`Best-pick agreement (top 20): ${agreements}/20`);

  console.log("\n=== Recommendation ===");
  if (jaccard >= 0.90) {
    console.log("512 dims produces nearly identical clusters. Safe to switch as default.");
  } else if (jaccard >= 0.80) {
    console.log("512 dims produces similar clusters with minor differences. Acceptable tradeoff for 2x storage savings.");
  } else {
    console.log("512 dims diverges significantly. Keep 1024 as default.");
  }
  console.log(`\nStorage impact: ~${((allItems.length * 512 * 4) / 1024 / 1024).toFixed(1)}MB at 512 vs ~${((allItems.length * 1024 * 4) / 1024 / 1024).toFixed(1)}MB at 1024`);

  // Cleanup benchmark DBs
  const { unlinkSync, existsSync } = await import("node:fs");
  for (const p of [db1024Path, db512Path]) {
    if (existsSync(p)) unlinkSync(p);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(p + suffix)) unlinkSync(p + suffix);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
