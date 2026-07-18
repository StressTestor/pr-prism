import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import { findDuplicateClusters } from "./cluster.js";
import { type EnvConfig, getRepos, loadConfig, loadEnvConfig, parseRepo } from "./config.js";
import { createEmbeddingProvider, type ProviderConfig, prepareEmbeddingText } from "./embeddings.js";
import { GitHubClient } from "./github.js";
import { endpointFingerprint, normalizeHttpBaseUrl } from "./provider-url.js";
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
  provider: string;
  dimensions: number;
  endpointFingerprint?: string;
  embedTimeMs: number;
  itemsPerMinute: number;
  clustersByThreshold: Record<string, number>;
}

export interface BenchmarkResult {
  repo: string;
  provider: string;
  models: ModelResult[];
  thresholds: number[];
  overlaps: Array<{ model: string; threshold: number; overlap: OverlapResult }>;
  timestamp: string;
}

export interface BenchmarkEndpointIdentity {
  baseUrl?: string;
  fingerprint?: string;
}

export function benchmarkDatabasePath(
  repoFull: string,
  provider: string,
  model: string,
  dimensions: number,
  endpoint?: BenchmarkEndpointIdentity,
): string {
  const slug = repoFull.replace(/[/:.]/g, "-");
  const providerSlug = provider.replace(/[/:.]/g, "-");
  const modelSlug = model.replace(/[/:.]/g, "-");
  const fingerprint = endpoint?.baseUrl ? endpointFingerprint(endpoint.baseUrl) : endpoint?.fingerprint;
  if (fingerprint && !/^[a-f0-9]{16}$/.test(fingerprint)) {
    throw new Error("benchmark endpoint fingerprint must be a 16-character lowercase hexadecimal value");
  }
  const endpointSuffix = fingerprint ? `-e${fingerprint}` : "";
  return resolve(
    process.cwd(),
    "data",
    `benchmark-${slug}-${providerSlug}-${modelSlug}-${dimensions}d${endpointSuffix}.db`,
  );
}

export function parseBenchmarkDimensions(value: string): number {
  const dimensions = Number(value);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error("benchmark dimensions must be a positive integer");
  }
  return dimensions;
}

export function resolveBenchmarkProviderConfig(
  opts: Pick<BenchmarkOptions, "provider" | "baseUrl" | "dimensions">,
  env: Pick<EnvConfig, "EMBEDDING_API_KEY" | "EMBEDDING_BASE_URL" | "EMBEDDING_DIMENSIONS">,
): Omit<ProviderConfig, "model"> {
  const provider = opts.provider || "ollama";
  const inheritOpenAIEnvironment = opts.provider === "openai";
  const configuredBaseUrl = opts.baseUrl ?? (inheritOpenAIEnvironment ? env.EMBEDDING_BASE_URL : undefined);
  const configuredDimensions = opts.dimensions ?? (inheritOpenAIEnvironment ? env.EMBEDDING_DIMENSIONS : undefined);
  return {
    provider,
    apiKey: provider === "ollama" ? undefined : env.EMBEDDING_API_KEY,
    baseUrl: configuredBaseUrl ? normalizeHttpBaseUrl(configuredBaseUrl) : undefined,
    dimensions: configuredDimensions === undefined ? undefined : parseBenchmarkDimensions(String(configuredDimensions)),
  };
}

export async function ensureBenchmarkModels(
  provider: string,
  models: string[],
  ensureModel: (model: string) => Promise<void> = ensureOllamaModel,
): Promise<void> {
  if (provider !== "ollama") return;
  for (const model of models) await ensureModel(model);
}

// ── cluster overlap ──────────────────────────────────────────────

export function computeClusterOverlap(clustersA: SimplifiedCluster[], clustersB: SimplifiedCluster[]): OverlapResult {
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

export async function runBenchmarkForModel(
  model: string,
  repoFull: string,
  thresholds: number[],
  allItems: PRItem[],
  providerConfig: Omit<ProviderConfig, "model">,
): Promise<ModelResult> {
  const spinner = ora(`[${model}] creating embedder`).start();
  let store: VectorStore | undefined;
  try {
    const embedder = await createEmbeddingProvider({ ...providerConfig, model });
    const dimensions = embedder.dimensions;
    const endpointId = providerConfig.baseUrl ? endpointFingerprint(providerConfig.baseUrl) : undefined;
    const dbPath = benchmarkDatabasePath(repoFull, providerConfig.provider, model, dimensions, {
      fingerprint: endpointId,
    });
    store = new VectorStore(dbPath, dimensions, model);

    if (allItems.length === 0) {
      spinner.warn(`[${model}] no items found in ${repoFull}`);
      return {
        model,
        provider: providerConfig.provider,
        dimensions,
        endpointFingerprint: endpointId,
        embedTimeMs: 0,
        itemsPerMinute: 0,
        clustersByThreshold: Object.fromEntries(thresholds.map((t) => [t.toString(), 0])),
      };
    }

    // embed in batches
    spinner.text = `[${model}] embedding ${allItems.length} items`;
    const batchSize = 50;
    const startTime = Date.now();

    let zeroVectors = 0;

    for (let i = 0; i < allItems.length; i += batchSize) {
      const batch = allItems.slice(i, i + batchSize);
      const texts = batch.map((item) => prepareEmbeddingText(item));

      let embeddings: number[][];
      try {
        embeddings = await embedder.embedBatch(texts);
      } catch (error) {
        if (providerConfig.provider !== "ollama") throw error;

        // Preserve the legacy Ollama recovery for models with small context windows.
        embeddings = [];
        for (const text of texts) {
          try {
            const truncated = text.slice(0, 500);
            const [single] = await embedder.embedBatch([truncated]);
            embeddings.push(single);
          } catch {
            embeddings.push(new Array(embedder.dimensions).fill(0));
            zeroVectors++;
          }
        }
      }

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

    if (zeroVectors > 0) {
      console.warn(chalk.yellow(`  warning: ${zeroVectors} items failed to embed (zero vectors)`));
    }

    spinner.text = `[${model}] clustering`;
    const clustersByThreshold: Record<string, number> = {};

    for (const threshold of thresholds) {
      const clusters = findDuplicateClusters(store, allItems, { threshold, repo: repoFull });
      clustersByThreshold[threshold.toString()] = clusters.length;
    }

    spinner.succeed(`[${model}] done — ${allItems.length} items, ${dimensions} dims, ${embedTimeMs}ms`);

    return {
      model,
      provider: providerConfig.provider,
      dimensions,
      endpointFingerprint: endpointId,
      embedTimeMs,
      itemsPerMinute,
      clustersByThreshold,
    };
  } catch (error) {
    spinner.fail(`[${model}] benchmark failed`);
    throw error;
  } finally {
    store?.close();
  }
}

// ── main benchmark runner ────────────────────────────────────────

export interface BenchmarkOptions {
  repo?: string;
  models: string;
  thresholds?: string;
  configPath?: string;
  provider?: string;
  baseUrl?: string;
  dimensions?: number;
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<void> {
  const models = opts.models
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length < 2) {
    console.error(chalk.red("benchmark requires at least 2 models (comma-separated)"));
    process.exit(1);
  }

  const thresholds = (opts.thresholds || "0.85,0.88,0.91")
    .split(",")
    .map((t) => parseFloat(t.trim()))
    .filter((t) => !Number.isNaN(t));

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
  const providerConfig = resolveBenchmarkProviderConfig(opts, env);
  const provider = providerConfig.provider;

  console.log(chalk.bold(`\nbenchmark: ${repoFull}`));
  console.log(`provider: ${provider}`);
  console.log(`models: ${models.join(", ")}`);
  console.log(`thresholds: ${thresholds.join(", ")}\n`);

  // Ollama retains its local availability checks and automatic pulls.
  await ensureBenchmarkModels(provider, models);

  // fetch items once (shared across all models)
  const { owner, repo } = parseRepo(repoFull);
  const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
  const fetchSpinner = ora("fetching PRs and issues (REST)...").start();
  const prs = await github.fetchPRs({
    state: "all",
    maxItems: 5000,
    onProgress: (fetched) => {
      fetchSpinner.text = `fetching PRs... ${fetched}`;
    },
  });
  fetchSpinner.text = "fetching issues...";
  const issues = await github.fetchIssues({
    state: "all",
    maxItems: 5000,
    onProgress: (fetched) => {
      fetchSpinner.text = `fetching issues... ${fetched}`;
    },
  });
  const allItems: PRItem[] = [...prs, ...issues];
  fetchSpinner.succeed(`fetched ${allItems.length} items (${prs.length} PRs, ${issues.length} issues)`);

  if (allItems.length === 0) {
    console.log(chalk.red("no items found. check your repo and token."));
    return;
  }

  // run benchmark for each model
  const results: ModelResult[] = [];
  for (const model of models) {
    const result = await runBenchmarkForModel(model, repoFull, thresholds, allItems, providerConfig);
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

  // ── overlap: each model vs baseline (first model) ───────────
  const baseline = results[0];
  const allOverlaps: Array<{ model: string; threshold: number; overlap: OverlapResult }> = [];

  // Load baseline clusters once per threshold
  for (const t of thresholds) {
    const baseDbPath = benchmarkDatabasePath(repoFull, baseline.provider, baseline.model, baseline.dimensions, {
      fingerprint: baseline.endpointFingerprint,
    });
    const baseStore = new VectorStore(baseDbPath);
    const baseItems = baseStore.getAllItems(repoFull) as unknown as PRItem[];
    const baseClusters = findDuplicateClusters(baseStore, baseItems, { threshold: t, repo: repoFull });
    const baseSimplified: SimplifiedCluster[] = baseClusters.map((c) => ({
      id: c.id,
      items: c.items.map((item) => item.number),
    }));
    baseStore.close();

    for (let ri = 1; ri < results.length; ri++) {
      const r = results[ri];
      const dbPath = benchmarkDatabasePath(repoFull, r.provider, r.model, r.dimensions, {
        fingerprint: r.endpointFingerprint,
      });
      const store = new VectorStore(dbPath);
      const items = store.getAllItems(repoFull) as unknown as PRItem[];
      const clusters = findDuplicateClusters(store, items, { threshold: t, repo: repoFull });
      const simplified: SimplifiedCluster[] = clusters.map((c) => ({
        id: c.id,
        items: c.items.map((item) => item.number),
      }));
      store.close();

      const overlap = computeClusterOverlap(baseSimplified, simplified);
      allOverlaps.push({ model: r.model, threshold: t, overlap });
    }
  }

  // Print overlap table per threshold
  for (const t of thresholds) {
    console.log(chalk.bold(`\ncluster overlap vs ${baseline.model} @ ${t}`));
    const overlapTable = new Table({
      head: ["model", "overlap %", "matched", `unique to baseline`, "unique to model"],
      style: { head: ["cyan"] },
    });

    for (const entry of allOverlaps.filter((o) => o.threshold === t)) {
      overlapTable.push([
        entry.model,
        `${entry.overlap.overlapPercent}%`,
        entry.overlap.matchedPairs.length,
        entry.overlap.uniqueToA,
        entry.overlap.uniqueToB,
      ]);
    }
    console.log(overlapTable.toString());
  }

  // ── save results ─────────────────────────────────────────────
  const benchmarkResult: BenchmarkResult = {
    repo: repoFull,
    provider,
    models: results,
    thresholds,
    overlaps: allOverlaps,
    timestamp: new Date().toISOString(),
  };

  const outPath = resolve(process.cwd(), "data", "benchmark-results.json");
  writeFileSync(outPath, JSON.stringify(benchmarkResult, null, 2));
  console.log(chalk.green(`\nresults saved to ${outPath}`));
}
