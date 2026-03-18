import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import { findDuplicateClusters } from "./cluster.js";
import { getRepos, loadConfig, loadEnvConfig, parseRepo } from "./config.js";
import { createEmbeddingProvider, prepareEmbeddingText } from "./embeddings.js";
import { GitHubClient } from "./github.js";
import { VectorStore } from "./store.js";
import type { PRItem, StoreItem } from "./types.js";

// ── types ────────────────────────────────────────────────────────

export interface SimplifiedCluster {
  id: number;
  items: number[];
}

export interface OverlapResult {
  overlapPercent: number;
  uniqueToA: number;
  uniqueToB: number;
  matchedPairs: Array<{ clusterA: number; clusterB: number; overlap: number }>;
}

export interface ModelResult {
  model: string;
  dimensions: number;
  embedTimeMs: number;
  itemsPerMinute: number;
  clustersByThreshold: Record<string, number>;
}

export interface BenchmarkResult {
  repo: string;
  models: ModelResult[];
  thresholds: number[];
  overlapByThreshold: Record<string, OverlapResult>;
  timestamp: string;
}

// ── cluster overlap ──────────────────────────────────────────────

export function computeClusterOverlap(
  clustersA: SimplifiedCluster[],
  clustersB: SimplifiedCluster[],
): OverlapResult {
  // both empty = identical = 100%
  if (clustersA.length === 0 && clustersB.length === 0) {
    return { overlapPercent: 100, uniqueToA: 0, uniqueToB: 0, matchedPairs: [] };
  }

  // one side empty = 0% overlap
  if (clustersA.length === 0 || clustersB.length === 0) {
    return {
      overlapPercent: 0,
      uniqueToA: clustersA.length,
      uniqueToB: clustersB.length,
      matchedPairs: [],
    };
  }

  // collect all items into global sets
  const setA = new Set<number>();
  const setB = new Set<number>();
  for (const c of clustersA) for (const item of c.items) setA.add(item);
  for (const c of clustersB) for (const item of c.items) setB.add(item);

  // global Jaccard similarity
  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) intersectionSize++;
  }
  const unionSize = new Set([...setA, ...setB]).size;
  const overlapPercent = unionSize === 0 ? 100 : Math.round((intersectionSize / unionSize) * 100);

  // greedy cluster matching: pair clusters with best item overlap first
  const matchedPairs: Array<{ clusterA: number; clusterB: number; overlap: number }> = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();

  // build all candidate pairs with their overlap scores
  const candidates: Array<{ idxA: number; idxB: number; overlap: number }> = [];
  for (let i = 0; i < clustersA.length; i++) {
    const itemsA = new Set(clustersA[i].items);
    for (let j = 0; j < clustersB.length; j++) {
      const itemsB = new Set(clustersB[j].items);
      let pairIntersection = 0;
      for (const item of itemsA) {
        if (itemsB.has(item)) pairIntersection++;
      }
      if (pairIntersection > 0) {
        const pairUnion = new Set([...itemsA, ...itemsB]).size;
        candidates.push({
          idxA: i,
          idxB: j,
          overlap: pairIntersection / pairUnion,
        });
      }
    }
  }

  // sort by overlap descending, greedily match
  candidates.sort((a, b) => b.overlap - a.overlap);
  for (const c of candidates) {
    if (usedA.has(c.idxA) || usedB.has(c.idxB)) continue;
    usedA.add(c.idxA);
    usedB.add(c.idxB);
    matchedPairs.push({
      clusterA: clustersA[c.idxA].id,
      clusterB: clustersB[c.idxB].id,
      overlap: Math.round(c.overlap * 100),
    });
  }

  const uniqueToA = clustersA.length - usedA.size;
  const uniqueToB = clustersB.length - usedB.size;

  return { overlapPercent, uniqueToA, uniqueToB, matchedPairs };
}

// ── ollama model management ──────────────────────────────────────

export async function ensureOllamaModel(model: string): Promise<void> {
  const spinner = ora(`checking model ${model}`).start();
  try {
    const resp = await fetch("http://localhost:11434/api/tags");
    if (!resp.ok) {
      spinner.fail("ollama responded with an error");
      throw new Error(`ollama /api/tags returned ${resp.status}`);
    }
    const data = (await resp.json()) as { models: Array<{ name: string }> };
    const available = data.models.map((m) => m.name);

    // check both exact match and match without tag suffix
    const found = available.some(
      (name) => name === model || name === `${model}:latest` || name.startsWith(`${model}:`),
    );

    if (found) {
      spinner.succeed(`model ${model} available`);
      return;
    }

    spinner.text = `pulling model ${model}...`;
    execFileSync("ollama", ["pull", model], { stdio: "inherit" });
    spinner.succeed(`model ${model} pulled`);
  } catch (err: any) {
    if (err.code === "ECONNREFUSED") {
      spinner.fail("ollama is not running");
      throw new Error("ollama is not running. start it with `ollama serve` and try again.");
    }
    // fetch failed for another reason or pull failed
    spinner.fail(`failed to ensure model ${model}`);
    throw err;
  }
}

// ── per-model benchmark run ──────────────────────────────────────

async function runBenchmarkForModel(
  model: string,
  repoFull: string,
  thresholds: number[],
  githubToken: string,
): Promise<ModelResult> {
  const slug = repoFull.replace(/[/:\.]/g, "-");
  const dbPath = resolve(process.cwd(), "data", `benchmark-${slug}-${model.replace(/[/:\.]/g, "-")}.db`);

  const spinner = ora(`[${model}] creating embedder`).start();

  const embedder = await createEmbeddingProvider({ provider: "ollama", model });
  const dimensions = embedder.dimensions;
  const store = new VectorStore(dbPath, dimensions, model);

  spinner.text = `[${model}] fetching PRs and issues`;

  const { owner, repo } = parseRepo(repoFull);
  const github = new GitHubClient(githubToken, owner, repo);

  const [prs, issues] = await Promise.all([
    github.fetchPRsGraphQL({ state: "all", maxItems: 5000 }),
    github.fetchIssuesGraphQL({ state: "all", maxItems: 5000 }),
  ]);

  const allItems: PRItem[] = [...prs, ...issues];

  if (allItems.length === 0) {
    spinner.warn(`[${model}] no items found in ${repoFull}`);
    store.close();
    return {
      model,
      dimensions,
      embedTimeMs: 0,
      itemsPerMinute: 0,
      clustersByThreshold: Object.fromEntries(thresholds.map((t) => [t.toString(), 0])),
    };
  }

  // embed in batches
  spinner.text = `[${model}] embedding ${allItems.length} items`;
  const batchSize = 50;
  const startTime = Date.now();

  for (let i = 0; i < allItems.length; i += batchSize) {
    const batch = allItems.slice(i, i + batchSize);
    const texts = batch.map((item) => prepareEmbeddingText(item));
    const embeddings = await embedder.embedBatch(texts);

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const id = `${item.repo}:${item.type}:${item.number}`;
      const storeItem: StoreItem = {
        id,
        type: item.type,
        number: item.number,
        repo: item.repo,
        title: item.title,
        bodySnippet: (item.body || "").slice(0, 500),
        embedding: new Float32Array(embeddings[j]),
        metadata: {
          author: item.author,
          state: item.state,
          labels: item.labels,
          additions: item.additions,
          deletions: item.deletions,
          changedFiles: item.changedFiles,
          ciStatus: item.ciStatus,
          reviewCount: item.reviewCount,
          hasTests: item.hasTests,
        },
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      store.upsert(storeItem);
    }

    spinner.text = `[${model}] embedded ${Math.min(i + batchSize, allItems.length)}/${allItems.length}`;
  }

  const embedTimeMs = Date.now() - startTime;
  const itemsPerMinute = Math.round((allItems.length / (embedTimeMs / 1000)) * 60);

  // cluster at each threshold
  spinner.text = `[${model}] clustering`;
  const clustersByThreshold: Record<string, number> = {};

  for (const threshold of thresholds) {
    const clusters = findDuplicateClusters(store, allItems, { threshold, repo: repoFull });
    clustersByThreshold[threshold.toString()] = clusters.length;
  }

  store.close();
  spinner.succeed(`[${model}] done — ${allItems.length} items, ${dimensions} dims, ${embedTimeMs}ms`);

  return { model, dimensions, embedTimeMs, itemsPerMinute, clustersByThreshold };
}

// ── main benchmark runner ────────────────────────────────────────

export interface BenchmarkOptions {
  repo?: string;
  models: string;
  thresholds?: string;
  configPath?: string;
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<void> {
  const models = opts.models.split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length < 2) {
    console.error(chalk.red("benchmark requires at least 2 models (comma-separated)"));
    process.exit(1);
  }

  const thresholds = (opts.thresholds || "0.85,0.88,0.91")
    .split(",")
    .map((t) => parseFloat(t.trim()))
    .filter((t) => !isNaN(t));

  // resolve repo
  let repoFull: string;
  if (opts.repo) {
    const parsed = parseRepo(opts.repo);
    repoFull = `${parsed.owner}/${parsed.repo}`;
  } else {
    const config = loadConfig(opts.configPath);
    const repos = getRepos(config);
    if (repos.length === 0) {
      console.error(chalk.red("no repo specified. use --repo or configure in prism.config.yaml"));
      process.exit(1);
    }
    repoFull = repos[0];
  }

  const env = loadEnvConfig();

  console.log(chalk.bold(`\nbenchmark: ${repoFull}`));
  console.log(`models: ${models.join(", ")}`);
  console.log(`thresholds: ${thresholds.join(", ")}\n`);

  // ensure all models are available
  for (const model of models) {
    await ensureOllamaModel(model);
  }

  // run benchmark for each model
  const results: ModelResult[] = [];
  for (const model of models) {
    const result = await runBenchmarkForModel(model, repoFull, thresholds, env.GITHUB_TOKEN);
    results.push(result);
  }

  // ── speed comparison table ───────────────────────────────────
  console.log(chalk.bold("\nspeed comparison"));
  const speedTable = new Table({
    head: ["model", "dims", "embed time", "items/min"],
    style: { head: ["cyan"] },
  });

  for (const r of results) {
    const timeSec = (r.embedTimeMs / 1000).toFixed(1);
    speedTable.push([r.model, r.dimensions, `${timeSec}s`, r.itemsPerMinute]);
  }
  console.log(speedTable.toString());

  // ── cluster comparison per threshold ─────────────────────────
  console.log(chalk.bold("\nclusters by threshold"));
  const clusterHead = ["threshold", ...models.map((m) => m)];
  const clusterTable = new Table({
    head: clusterHead,
    style: { head: ["cyan"] },
  });

  for (const t of thresholds) {
    const row: (string | number)[] = [t.toString()];
    for (const r of results) {
      row.push(r.clustersByThreshold[t.toString()] ?? 0);
    }
    clusterTable.push(row);
  }
  console.log(clusterTable.toString());

  // ── overlap between first two models ─────────────────────────
  console.log(chalk.bold("\ncluster overlap (model 1 vs model 2)"));
  const [r1, r2] = results;
  const overlapByThreshold: Record<string, OverlapResult> = {};

  // reload clusters for overlap computation
  for (const t of thresholds) {
    // simplified clusters using item numbers from the cluster results
    // re-run clustering to get actual cluster membership
    const slug1 = repoFull.replace(/[/:\.]/g, "-");
    const db1Path = resolve(process.cwd(), "data", `benchmark-${slug1}-${r1.model.replace(/[/:\.]/g, "-")}.db`);
    const db2Path = resolve(process.cwd(), "data", `benchmark-${slug1}-${r2.model.replace(/[/:\.]/g, "-")}.db`);

    const store1 = new VectorStore(db1Path);
    const store2 = new VectorStore(db2Path);

    const items1 = store1.getAllItems(repoFull) as unknown as PRItem[];
    const items2 = store2.getAllItems(repoFull) as unknown as PRItem[];

    const clusters1 = findDuplicateClusters(store1, items1, { threshold: t, repo: repoFull });
    const clusters2 = findDuplicateClusters(store2, items2, { threshold: t, repo: repoFull });

    store1.close();
    store2.close();

    const simplified1: SimplifiedCluster[] = clusters1.map((c) => ({
      id: c.id,
      items: c.items.map((item) => item.number),
    }));
    const simplified2: SimplifiedCluster[] = clusters2.map((c) => ({
      id: c.id,
      items: c.items.map((item) => item.number),
    }));

    const overlap = computeClusterOverlap(simplified1, simplified2);
    overlapByThreshold[t.toString()] = overlap;

    console.log(
      `  threshold ${t}: ${overlap.overlapPercent}% overlap, ` +
        `${overlap.matchedPairs.length} matched, ` +
        `${overlap.uniqueToA} unique to ${r1.model}, ${overlap.uniqueToB} unique to ${r2.model}`,
    );
  }

  // ── save results ─────────────────────────────────────────────
  const benchmarkResult: BenchmarkResult = {
    repo: repoFull,
    models: results,
    thresholds,
    overlapByThreshold,
    timestamp: new Date().toISOString(),
  };

  const outPath = resolve(process.cwd(), "data", "benchmark-results.json");
  writeFileSync(outPath, JSON.stringify(benchmarkResult, null, 2));
  console.log(chalk.green(`\nresults saved to ${outPath}`));
}
