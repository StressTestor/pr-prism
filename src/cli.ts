#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";
import { writeFileSync, existsSync, copyFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";
import { loadConfig, loadEnvConfig, parseRepo } from "./config.js";
import { GitHubClient } from "./github.js";
import { createEmbeddingProvider, prepareEmbeddingText } from "./embeddings.js";
import { VectorStore } from "./store.js";
import { findDuplicateClusters } from "./cluster.js";
import { rankPRs, buildScorerContext } from "./scorer.js";
import { checkVisionAlignment } from "./vision.js";
import { reviewPR } from "./reviewer.js";
import { ensureLabelsExist, applyLabelActions, type LabelAction } from "./labels.js";
import type { PRItem, StoreItem } from "./types.js";

const program = new Command();

program
  .name("prism")
  .description("BYOK GitHub PR/Issue triage tool — de-duplicate, rank, and vision-check PRs at scale")
  .version("0.4.1");

// ── helpers ─────────────────────────────────────────────────────
export function parseDuration(s: string): string {
  const match = s.match(/^(\d+)(d|w|m)$/);
  if (!match) throw new Error(`Invalid duration: ${s}. Use format like 7d, 2w, 1m`);
  const [, num, unit] = match;
  const days = unit === "d" ? parseInt(num) : unit === "w" ? parseInt(num) * 7 : parseInt(num) * 30;
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

// ── pipeline functions (used by individual commands and triage) ──

interface PipelineContext {
  config: ReturnType<typeof loadConfig>;
  env: ReturnType<typeof loadEnvConfig>;
  owner: string;
  repo: string;
  repoFull: string;
  github: GitHubClient;
  store: VectorStore;
}

async function createPipelineContext(repoOverride?: string): Promise<PipelineContext> {
  const config = loadConfig();
  const env = loadEnvConfig();
  const { owner, repo } = parseRepo(repoOverride || config.repo);
  const repoFull = `${owner}/${repo}`;
  const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
  const embedder = await createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    apiKey: env.EMBEDDING_API_KEY,
    model: env.EMBEDDING_MODEL,
  });
  const store = new VectorStore(undefined, embedder.dimensions);
  return { config, env, owner, repo, repoFull, github, store };
}

export async function runScan(ctx: PipelineContext, opts: { since?: string; state?: string; useRest?: boolean }) {
  const { config, env, repoFull, github, store } = ctx;
  const since = opts.since ? parseDuration(opts.since) : undefined;
  const states = (opts.state || "open").split(",") as Array<"open" | "closed">;

  let allItems: PRItem[] = [];

  if (opts.useRest) {
    // REST fallback — no deep scan signals
    const rateLimitWarning = github.formatRateLimitWarning(config.max_prs);
    if (rateLimitWarning) console.log(chalk.yellow(rateLimitWarning));

    for (const state of states) {
      const spinner = ora(`Fetching ${state} PRs from ${repoFull} (REST)...`).start();
      const prs = await github.fetchPRs({
        since, state, maxItems: config.max_prs, batchSize: config.batch_size,
        onProgress: (fetched) => { spinner.text = `Fetching ${state} PRs... ${fetched} so far`; },
      });
      spinner.succeed(`Fetched ${prs.length} ${state} PRs`);

      const issueSpinner = ora(`Fetching ${state} issues...`).start();
      const issues = await github.fetchIssues({ since, state, maxItems: config.max_prs, batchSize: config.batch_size });
      issueSpinner.succeed(`Fetched ${issues.length} ${state} issues`);

      allItems.push(...prs, ...issues);
    }
  } else {
    // GraphQL — gets CI, reviews, test files inline
    for (const state of states) {
      const spinner = ora(`Fetching ${state} PRs from ${repoFull} (GraphQL)...`).start();
      const prs = await github.fetchPRsGraphQL({
        since, state, maxItems: config.max_prs,
        onProgress: (fetched, total) => { spinner.text = `Fetching ${state} PRs... ${fetched}/${total}`; },
      });
      spinner.succeed(`Fetched ${prs.length} ${state} PRs (with CI, reviews, tests)`);

      const issueSpinner = ora(`Fetching ${state} issues...`).start();
      const issues = await github.fetchIssuesGraphQL({
        since, state, maxItems: config.max_prs,
        onProgress: (fetched, total) => { issueSpinner.text = `Fetching ${state} issues... ${fetched}/${total}`; },
      });
      issueSpinner.succeed(`Fetched ${issues.length} ${state} issues`);

      allItems.push(...prs, ...issues);
    }
  }

  const rl = github.getRateLimit();
  console.log(chalk.dim(`API budget: ${rl.remaining}/${rl.limit} remaining`));

  // Filter unchanged
  const newItems: PRItem[] = [];
  let skipped = 0;
  for (const item of allItems) {
    const existing = store.getByNumber(repoFull, item.number);
    if (existing && existing.updatedAt === item.updatedAt) {
      skipped++;
    } else {
      newItems.push(item);
    }
  }

  if (skipped > 0) {
    console.log(chalk.dim(`Skipping ${skipped} unchanged items, embedding ${newItems.length} new/updated`));
  }

  // Embed and store
  const embedder = await createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    apiKey: env.EMBEDDING_API_KEY,
    model: env.EMBEDDING_MODEL,
  });
  const embedSpinner = ora(`Embedding ${newItems.length} items...`).start();
  const BATCH_SIZE = env.EMBEDDING_PROVIDER === "ollama" ? 50 : 10;
  let embedded = 0;

  for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
    const batch = newItems.slice(i, i + BATCH_SIZE);
    const texts = batch.map(item => prepareEmbeddingText(item));
    const embedWithRetry = async (input: string[]): Promise<number[][]> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await embedder.embedBatch(input);
        } catch (e: any) {
          const msg = e.message || "";
          if (msg.includes("429")) {
            const wait = 60 * (attempt + 1);
            embedSpinner.text = `Rate limited, waiting ${wait}s... (${embedded}/${newItems.length})`;
            await new Promise(r => setTimeout(r, wait * 1000));
          } else if (attempt < 2) {
            embedSpinner.text = `Error (${msg.slice(0, 60)}), retry ${attempt + 1}/3... (${embedded}/${newItems.length})`;
            await new Promise(r => setTimeout(r, 5000));
          } else {
            throw e;
          }
        }
      }
      throw new Error("unreachable");
    };

    let embeddings: number[][];
    try {
      embeddings = await embedWithRetry(texts);
    } catch {
      embedSpinner.text = `Batch failed, trying individually... (${embedded}/${newItems.length})`;
      embeddings = [];
      for (const text of texts) {
        try {
          const [single] = await embedWithRetry([text]);
          embeddings.push(single);
        } catch {
          embeddings.push(new Array(embedder.dimensions).fill(0));
        }
      }
    }

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const storeItem: StoreItem = {
        id: `${repoFull}:${item.type}:${item.number}`,
        type: item.type,
        number: item.number,
        repo: repoFull,
        title: item.title,
        bodySnippet: item.body.slice(0, 500),
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

    embedded += batch.length;
    embedSpinner.text = `Embedding... ${embedded}/${newItems.length}`;
  }

  embedSpinner.succeed(`Embedded ${newItems.length} new items (${skipped} unchanged, ${allItems.length} total)`);

  const stats = store.getStats(repoFull);
  console.log(chalk.bold(`\nDatabase: ${stats.prs} PRs, ${stats.issues} issues, ${stats.diffs} cached diffs`));
}

export async function runDupes(ctx: PipelineContext, opts: { threshold?: number; applyLabels?: boolean; dryRun?: boolean }) {
  const { config, env, owner, repo, repoFull, store } = ctx;
  const threshold = opts.threshold ?? config.thresholds.duplicate_similarity;
  const items = store.getAllItems(repoFull) as unknown as PRItem[];
  const spinner = ora("Clustering duplicates...").start();

  const clusters = findDuplicateClusters(store, items, { threshold, repo: repoFull });
  spinner.succeed(`Found ${clusters.length} duplicate clusters`);

  const table = new Table({
    head: ["#", "Size", "Avg Sim", "Best Pick", "Theme"],
    colWidths: [6, 6, 10, 12, 50],
  });

  for (const cluster of clusters) {
    table.push([
      cluster.id,
      cluster.items.length,
      `${(cluster.avgSimilarity * 100).toFixed(1)}%`,
      `#${cluster.bestPick.number}`,
      cluster.theme.slice(0, 48),
    ]);
  }

  console.log(table.toString());
  console.log(chalk.dim(`\nTotal: ${clusters.reduce((s, c) => s + c.items.length, 0)} items across ${clusters.length} clusters`));

  if (opts.applyLabels || opts.dryRun) {
    const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    if (opts.applyLabels) await ensureLabelsExist(github, config);

    const actions: LabelAction[] = [];
    for (const cluster of clusters) {
      for (const item of cluster.items) {
        actions.push({
          number: item.number,
          action: "add",
          label: config.labels.duplicate,
          reason: `Cluster #${cluster.id} (${cluster.items.length} items)`,
        });
      }
      actions.push({
        number: cluster.bestPick.number,
        action: "add",
        label: config.labels.top_pick,
        reason: `Best pick in cluster #${cluster.id}`,
      });
    }

    const applied = await applyLabelActions(github, actions, opts.dryRun);
    const verb = opts.dryRun ? "Would apply" : "Applied";
    console.log(chalk.green(`\n${verb} ${applied.length} labels`));
  }

  return clusters;
}

export async function runRank(ctx: PipelineContext, opts: { top?: number }) {
  const { config, repoFull, github, store } = ctx;
  const items = store.getAllItems(repoFull) as unknown as PRItem[];

  const spinner = ora("Building scorer context...").start();
  const context = await buildScorerContext(items, github);
  spinner.succeed("Scorer context ready");

  const ranked = rankPRs(items, config, context);
  const top = ranked.slice(0, opts.top || 20);

  const table = new Table({
    head: ["Rank", "#", "Score", "Author", "Title"],
    colWidths: [6, 8, 8, 16, 50],
  });

  top.forEach((pr, i) => {
    table.push([
      i + 1,
      pr.number,
      pr.score.toFixed(2),
      (pr.author || "unknown").slice(0, 14),
      pr.title.slice(0, 48),
    ]);
  });

  console.log(table.toString());
  return ranked;
}

export async function runVision(ctx: PipelineContext, opts: { doc?: string; applyLabels?: boolean; dryRun?: boolean }) {
  const { config, env, owner, repo, repoFull, github, store } = ctx;
  let docPath = opts.doc || config.vision_doc;

  if (!docPath || !existsSync(docPath)) {
    const fetchSpinner = ora("Fetching vision document from repo...").start();
    for (const candidate of ["VISION.md", "README.md"]) {
      const content = await github.fetchFileContent(candidate);
      if (content) {
        const localPath = resolve(process.cwd(), "data", candidate);
        writeFileSync(localPath, content);
        docPath = localPath;
        fetchSpinner.succeed(`Using ${candidate} from repo as vision document`);
        break;
      }
    }
    if (!docPath || !existsSync(docPath)) {
      console.log(chalk.yellow("No vision document found locally or in repo (tried VISION.md, README.md)"));
      return null;
    }
  }

  const embedder = await createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    apiKey: env.EMBEDDING_API_KEY,
    model: env.EMBEDDING_MODEL,
  });

  const spinner = ora("Checking vision alignment...").start();
  const scores = await checkVisionAlignment(store, embedder, config, docPath, repoFull);
  spinner.succeed("Vision alignment checked");

  const aligned = scores.filter(s => s.classification === "aligned");
  const drifting = scores.filter(s => s.classification === "drifting");
  const offVision = scores.filter(s => s.classification === "off-vision");

  console.log(chalk.green(`  Aligned: ${aligned.length}`));
  console.log(chalk.yellow(`  Drifting: ${drifting.length}`));
  console.log(chalk.red(`  Off-vision: ${offVision.length}`));

  if (offVision.length > 0) {
    console.log(chalk.bold("\nOff-vision PRs:"));
    const table = new Table({ head: ["#", "Score", "Matched Section"], colWidths: [8, 8, 50] });
    for (const s of offVision.slice(0, 20)) {
      table.push([s.prNumber, s.score.toFixed(2), s.matchedSection.slice(0, 48)]);
    }
    console.log(table.toString());
  }

  if (opts.applyLabels || opts.dryRun) {
    const labelGithub = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    if (opts.applyLabels) await ensureLabelsExist(labelGithub, config);

    const actions: LabelAction[] = scores.map(s => ({
      number: s.prNumber,
      action: "add" as const,
      label: config.labels[s.classification === "off-vision" ? "off_vision" : s.classification],
      reason: `Vision score: ${s.score.toFixed(2)} → ${s.classification}`,
    }));

    await applyLabelActions(labelGithub, actions, opts.dryRun);
    console.log(chalk.green(`\n${opts.dryRun ? "Would apply" : "Applied"} ${actions.length} labels`));
  }

  return scores;
}

// ── init ────────────────────────────────────────────────────────
program
  .command("init")
  .description("Initialize pr-prism configuration in current directory")
  .action(async () => {
    const envExample = resolve(import.meta.dirname, "..", ".env.example");
    const configExample = resolve(import.meta.dirname, "..", "prism.config.yaml");

    if (!existsSync(".env") && existsSync(envExample)) {
      copyFileSync(envExample, ".env");
      console.log(chalk.green("✓") + " Created .env (edit with your API keys)");
    } else if (existsSync(".env")) {
      console.log(chalk.yellow("⊘") + " .env already exists");
    }

    if (!existsSync("prism.config.yaml") && existsSync(configExample)) {
      copyFileSync(configExample, "prism.config.yaml");
      console.log(chalk.green("✓") + " Created prism.config.yaml (edit repo and settings)");
    } else if (existsSync("prism.config.yaml")) {
      console.log(chalk.yellow("⊘") + " prism.config.yaml already exists");
    }

    console.log("\n" + chalk.bold("Next steps:"));
    console.log("  1. Edit .env with your GitHub token and AI provider keys");
    console.log("  2. Edit prism.config.yaml with your repo and preferences");
    console.log("  3. Run: prism scan");
  });

// ── scan ────────────────────────────────────────────────────────
program
  .command("scan")
  .description("Ingest PRs and issues into local database")
  .option("-r, --repo <owner/repo>", "Repository to scan")
  .option("-s, --since <duration>", "Only fetch items updated within duration (e.g., 7d, 2w, 1m)")
  .option("--state <states>", "PR states to fetch (open,closed)", "open")
  .option("--rest", "Use REST API instead of GraphQL (no deep scan signals)")
  .action(async (opts) => {
    const ctx = await createPipelineContext(opts.repo);
    try {
      await runScan(ctx, { since: opts.since, state: opts.state, useRest: opts.rest });
    } finally {
      ctx.store.close();
    }
  });

// ── dupes ───────────────────────────────────────────────────────
program
  .command("dupes")
  .description("Find duplicate PR/issue clusters")
  .option("-t, --threshold <number>", "Similarity threshold", "0.85")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("--cluster <id>", "Show specific cluster details")
  .option("--diff", "Show diff comparison within cluster")
  .option("--apply-labels", "Apply labels to GitHub")
  .option("--dry-run", "Show what would be labeled without applying")
  .action(async (opts) => {
    const ctx = await createPipelineContext(opts.repo);
    try {
      if (opts.cluster) {
        // Show specific cluster detail
        const items = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        const threshold = parseFloat(opts.threshold) || ctx.config.thresholds.duplicate_similarity;
        const clusters = findDuplicateClusters(ctx.store, items, { threshold, repo: ctx.repoFull });
        const cluster = clusters.find(c => c.id === parseInt(opts.cluster));
        if (!cluster) {
          console.log(chalk.red(`Cluster #${opts.cluster} not found`));
          return;
        }
        console.log(chalk.bold(`\nCluster #${cluster.id}: "${cluster.theme}"`));
        console.log(`Items: ${cluster.items.length} | Avg similarity: ${(cluster.avgSimilarity * 100).toFixed(1)}%\n`);
        for (const item of cluster.items) {
          const isBest = item.number === cluster.bestPick.number;
          const prefix = isBest ? chalk.green("★") : " ";
          console.log(`${prefix} #${item.number} ${item.title}`);
          console.log(`  Author: ${item.author} | Updated: ${item.updatedAt.slice(0, 10)} | Score: ${item.score.toFixed(2)}`);
        }
      } else {
        await runDupes(ctx, {
          threshold: parseFloat(opts.threshold) || undefined,
          applyLabels: opts.applyLabels,
          dryRun: opts.dryRun,
        });
      }
    } finally {
      ctx.store.close();
    }
  });

// ── rank ────────────────────────────────────────────────────────
program
  .command("rank")
  .description("Score and rank PRs by quality signals")
  .option("-n, --top <number>", "Show top N results", "20")
  .option("-r, --repo <owner/repo>", "Repository")
  .action(async (opts) => {
    const ctx = await createPipelineContext(opts.repo);
    try {
      await runRank(ctx, { top: parseInt(opts.top) || 20 });
    } finally {
      ctx.store.close();
    }
  });

// ── vision ──────────────────────────────────────────────────────
program
  .command("vision")
  .description("Check PRs against vision document for alignment")
  .option("-d, --doc <path>", "Path to vision document")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("--apply-labels", "Apply alignment labels")
  .option("--dry-run", "Show what would be labeled")
  .action(async (opts) => {
    const ctx = await createPipelineContext(opts.repo);
    try {
      await runVision(ctx, { doc: opts.doc, applyLabels: opts.applyLabels, dryRun: opts.dryRun });
    } finally {
      ctx.store.close();
    }
  });

// ── review ──────────────────────────────────────────────────────
program
  .command("review <pr-number>")
  .description("Deep LLM review of a specific PR")
  .option("-m, --model <model>", "Override LLM model")
  .option("-r, --repo <owner/repo>", "Repository")
  .action(async (prNumber: string, opts) => {
    const config = loadConfig();
    const env = loadEnvConfig();
    const { owner, repo } = parseRepo(opts.repo || config.repo);
    const num = parseInt(prNumber, 10);

    const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    const embedder = await createEmbeddingProvider({
      provider: env.EMBEDDING_PROVIDER,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
    });
    const store = new VectorStore(undefined, embedder.dimensions);

    const spinner = ora(`Fetching PR #${num}...`).start();
    let pr: PRItem;
    try {
      pr = await github.getPR(num);
    } catch {
      spinner.fail(`PR #${num} not found`);
      store.close();
      return;
    }

    spinner.text = `Fetching diff for #${num}...`;
    const diff = await github.fetchDiff(num, store);
    spinner.succeed(`Loaded PR #${num}`);

    const reviewSpinner = ora(`Reviewing with ${opts.model || env.LLM_MODEL}...`).start();
    const result = await reviewPR(pr.title, pr.body, diff, {
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY,
      model: opts.model || env.LLM_MODEL,
    });
    reviewSpinner.succeed("Review complete");

    console.log(chalk.bold(`\n  PR #${num}: ${pr.title}`));
    console.log(`  Author: ${pr.author} | ${pr.additions ?? "?"}+/${pr.deletions ?? "?"}−\n`);
    console.log(chalk.bold("  Summary:"), result.summary);

    if (result.concerns.length > 0) {
      console.log(chalk.bold("\n  Concerns:"));
      for (const c of result.concerns) {
        console.log(`    • ${c}`);
      }
    }

    const recColor = result.recommendation === "merge" ? chalk.green
      : result.recommendation === "revise" ? chalk.yellow
      : chalk.red;
    console.log(chalk.bold("\n  Recommendation:"), recColor(result.recommendation.toUpperCase()));
    console.log(chalk.bold("  Confidence:"), `${(result.confidence * 100).toFixed(0)}%`);

    store.close();
  });

// ── triage ──────────────────────────────────────────────────────
program
  .command("triage")
  .description("Full pipeline: scan → dupes → rank → vision")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("--apply-labels", "Apply all labels")
  .option("--dry-run", "Show what would happen without applying")
  .option("--rest", "Use REST API instead of GraphQL")
  .action(async (opts) => {
    console.log(chalk.bold("🔍 pr-prism triage\n"));
    console.log(chalk.dim("Running: scan → dupes → rank → vision\n"));

    const ctx = await createPipelineContext(opts.repo);
    try {
      await runScan(ctx, { useRest: opts.rest });
      console.log();

      await runDupes(ctx, { applyLabels: opts.applyLabels, dryRun: opts.dryRun });
      console.log();

      await runRank(ctx, { top: 20 });
      console.log();

      await runVision(ctx, { applyLabels: opts.applyLabels, dryRun: opts.dryRun });
    } finally {
      ctx.store.close();
    }

    console.log(chalk.bold("\n✓ Triage complete"));
  });

// ── reset ───────────────────────────────────────────────────────
program
  .command("reset")
  .description("Delete the local database and start fresh")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (opts) => {
    const dbPath = resolve(process.cwd(), "data", "prism.db");
    if (!existsSync(dbPath)) {
      console.log(chalk.yellow("No database found at " + dbPath));
      return;
    }

    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => {
        rl.question(chalk.yellow("Delete database and all cached data? (y/N) "), resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    unlinkSync(dbPath);
    // Also remove WAL/SHM files if they exist
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
    console.log(chalk.green("✓") + " Database deleted. Run `prism scan` to rebuild.");
  });

// ── status ──────────────────────────────────────────────────────
program
  .command("status")
  .description("Show database stats and rate limit info")
  .option("-r, --repo <owner/repo>", "Repository")
  .action(async (opts) => {
    const config = loadConfig();
    const env = loadEnvConfig();
    const { owner, repo } = parseRepo(opts.repo || config.repo);
    const repoFull = `${owner}/${repo}`;

    const embedder = await createEmbeddingProvider({
      provider: env.EMBEDDING_PROVIDER,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
    });
    const store = new VectorStore(undefined, embedder.dimensions);
    const stats = store.getStats(repoFull);

    console.log(chalk.bold("pr-prism status\n"));
    console.log(`  Repo:     ${repoFull}`);
    console.log(`  PRs:      ${stats.prs}`);
    console.log(`  Issues:   ${stats.issues}`);
    console.log(`  Diffs:    ${stats.diffs} cached`);
    console.log(`  Total:    ${stats.totalItems} items\n`);

    const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    try {
      await github.fetchPRs({ maxItems: 1 });
      const rl = github.getRateLimit();
      const resetIn = Math.max(0, Math.ceil((rl.resetAt.getTime() - Date.now()) / 60000));
      console.log(`  API:      ${rl.remaining}/${rl.limit} calls remaining (resets in ${resetIn}min)`);
    } catch {
      console.log(chalk.yellow("  API:      Could not check rate limit"));
    }

    console.log(`  Provider: ${env.EMBEDDING_PROVIDER} (${env.EMBEDDING_MODEL})`);
    console.log(`  LLM:      ${env.LLM_PROVIDER} (${env.LLM_MODEL})`);

    store.close();
  });

// ── report ──────────────────────────────────────────────────────
program
  .command("report")
  .description("Generate a markdown triage report")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("-o, --output <path>", "Output file path", "prism-report.md")
  .option("--top <number>", "Top N ranked PRs to include", "20")
  .option("--clusters <number>", "Top N duplicate clusters to include", "25")
  .action(async (opts) => {
    const config = loadConfig();
    const env = loadEnvConfig();
    const { owner, repo } = parseRepo(opts.repo || config.repo);
    const repoFull = `${owner}/${repo}`;

    const embedder = await createEmbeddingProvider({
      provider: env.EMBEDDING_PROVIDER,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
    });
    const store = new VectorStore(undefined, embedder.dimensions);
    const stats = store.getStats(repoFull);
    const items = store.getAllItems(repoFull) as unknown as PRItem[];

    if (items.length === 0) {
      console.log(chalk.red("No data found. Run `prism scan` first."));
      store.close();
      return;
    }

    const spinner = ora("Generating report...").start();

    const clusters = findDuplicateClusters(store, items, {
      threshold: config.thresholds.duplicate_similarity,
      repo: repoFull,
    });
    const dupeItemCount = clusters.reduce((s, c) => s + c.items.length, 0);

    const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    spinner.text = "Building scorer context...";
    const context = await buildScorerContext(items, github);
    const ranked = rankPRs(items, config, context);

    let visionResults: { aligned: number; drifting: number; offVision: number } | null = null;

    let visionDocPath = config.vision_doc;
    if (!visionDocPath || !existsSync(visionDocPath)) {
      for (const candidate of ["VISION.md", "README.md"]) {
        const content = await github.fetchFileContent(candidate);
        if (content) {
          const localPath = resolve(process.cwd(), "data", candidate);
          writeFileSync(localPath, content);
          visionDocPath = localPath;
          break;
        }
      }
    }

    if (visionDocPath && existsSync(visionDocPath)) {
      spinner.text = "Checking vision alignment...";
      const scores = await checkVisionAlignment(store, embedder, config, visionDocPath, repoFull);
      visionResults = {
        aligned: scores.filter(s => s.classification === "aligned").length,
        drifting: scores.filter(s => s.classification === "drifting").length,
        offVision: scores.filter(s => s.classification === "off-vision").length,
      };
    }

    const topN = parseInt(opts.top) || 20;
    const clusterN = parseInt(opts.clusters) || 25;
    const now = new Date().toISOString().slice(0, 10);

    let report = `# pr-prism triage report\n\n`;
    report += `**repo:** ${repoFull}  \n`;
    report += `**date:** ${now}  \n`;
    report += `**items scanned:** ${stats.totalItems} (${stats.prs} PRs, ${stats.issues} issues)\n\n`;

    report += `## overview\n\n`;
    report += `| metric | count |\n|--------|-------|\n`;
    report += `| open PRs scanned | ${stats.prs} |\n`;
    report += `| open issues scanned | ${stats.issues} |\n`;
    report += `| duplicate clusters | ${clusters.length} |\n`;
    report += `| items in duplicate clusters | ${dupeItemCount} (${(dupeItemCount / stats.totalItems * 100).toFixed(0)}% of total) |\n`;
    if (visionResults) {
      report += `| vision-aligned | ${visionResults.aligned} |\n`;
      report += `| vision-drifting | ${visionResults.drifting} |\n`;
      report += `| vision off-track | ${visionResults.offVision} |\n`;
    }
    report += `\n`;

    report += `## duplicate clusters (top ${clusterN})\n\n`;
    report += `these PRs/issues are similar enough to likely be duplicates. the "best pick" is the highest-quality item in each group.\n\n`;
    report += `| # | size | avg similarity | best pick | theme |\n`;
    report += `|---|------|---------------|-----------|-------|\n`;
    for (const cluster of clusters.slice(0, clusterN)) {
      const theme = cluster.theme.replace(/\|/g, "\\|").slice(0, 60);
      report += `| ${cluster.id} | ${cluster.items.length} | ${(cluster.avgSimilarity * 100).toFixed(1)}% | [#${cluster.bestPick.number}](https://github.com/${repoFull}/pull/${cluster.bestPick.number}) | ${theme} |\n`;
    }
    report += `\n`;

    const bigClusters = clusters.filter(c => c.items.length >= 10).slice(0, 10);
    if (bigClusters.length > 0) {
      report += `## largest duplicate groups\n\n`;
      for (const cluster of bigClusters) {
        report += `### cluster #${cluster.id}: ${cluster.theme.slice(0, 80)} (${cluster.items.length} items)\n\n`;
        report += `| # | author | title | updated |\n`;
        report += `|---|--------|-------|--------|\n`;
        for (const item of cluster.items.slice(0, 15)) {
          const title = item.title.replace(/\|/g, "\\|").slice(0, 60);
          report += `| [#${item.number}](https://github.com/${repoFull}/pull/${item.number}) | ${item.author || "?"} | ${title} | ${item.updatedAt.slice(0, 10)} |\n`;
        }
        if (cluster.items.length > 15) {
          report += `| ... | | +${cluster.items.length - 15} more | |\n`;
        }
        report += `\n`;
      }
    }

    report += `## top ${topN} ranked PRs\n\n`;
    report += `ranked by quality signals: description quality, author track record, recency, CI status, review approvals.\n\n`;
    report += `| rank | # | score | author | title |\n`;
    report += `|------|---|-------|--------|-------|\n`;
    for (let i = 0; i < Math.min(topN, ranked.length); i++) {
      const pr = ranked[i];
      const title = pr.title.replace(/\|/g, "\\|").slice(0, 60);
      report += `| ${i + 1} | [#${pr.number}](https://github.com/${repoFull}/pull/${pr.number}) | ${pr.score.toFixed(2)} | ${pr.author || "?"} | ${title} |\n`;
    }
    report += `\n`;

    if (visionResults) {
      report += `## vision alignment\n\n`;
      report += `checked against the project's README for alignment with stated goals.\n\n`;
      report += `- **aligned:** ${visionResults.aligned} items match the project vision\n`;
      report += `- **drifting:** ${visionResults.drifting} items are loosely related\n`;
      report += `- **off-vision:** ${visionResults.offVision} items don't match the project direction\n`;
      report += `\n`;
    }

    report += `---\n*generated by [pr-prism](https://github.com/StressTestor/pr-prism)*\n`;

    writeFileSync(opts.output, report);
    spinner.succeed(`Report saved to ${opts.output}`);

    console.log(chalk.dim(`  ${stats.totalItems} items, ${clusters.length} duplicate clusters, top ${topN} ranked`));
    store.close();
  });

program.parse();
