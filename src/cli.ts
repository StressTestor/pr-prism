#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";
import { writeFileSync, existsSync, copyFileSync } from "fs";
import { resolve } from "path";
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
  .version("0.1.0");

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
  .action(async (opts) => {
    const config = loadConfig();
    const env = loadEnvConfig();
    const { owner, repo } = parseRepo(opts.repo || config.repo);
    const repoFull = `${owner}/${repo}`;

    const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    const embedder = createEmbeddingProvider({
      provider: env.EMBEDDING_PROVIDER,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
    });
    const store = new VectorStore(undefined, embedder.dimensions);

    const since = opts.since ? parseDuration(opts.since) : undefined;
    const states = opts.state.split(",") as Array<"open" | "closed">;

    // Rate limit check
    const rateLimitWarning = github.formatRateLimitWarning(config.max_prs);
    if (rateLimitWarning) {
      console.log(chalk.yellow(rateLimitWarning));
    }

    let allItems: PRItem[] = [];

    for (const state of states) {
      const spinner = ora(`Fetching ${state} PRs from ${repoFull}...`).start();
      const prs = await github.fetchPRs({
        since,
        state,
        maxItems: config.max_prs,
        batchSize: config.batch_size,
        onProgress: (fetched) => {
          spinner.text = `Fetching ${state} PRs... ${fetched} so far`;
        },
      });
      spinner.succeed(`Fetched ${prs.length} ${state} PRs`);

      const issueSpinner = ora(`Fetching ${state} issues...`).start();
      const issues = await github.fetchIssues({
        since,
        state,
        maxItems: config.max_prs,
        batchSize: config.batch_size,
      });
      issueSpinner.succeed(`Fetched ${issues.length} ${state} issues`);

      allItems.push(...prs, ...issues);
    }

    // Rate limit status after fetching
    const rl = github.getRateLimit();
    console.log(chalk.dim(`API budget: ${rl.remaining}/${rl.limit} remaining`));

    // Filter out items that already exist in DB with the same updated_at
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
    const embedSpinner = ora(`Embedding ${newItems.length} items...`).start();
    const BATCH_SIZE = 10;
    let embedded = 0;

    for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
      const batch = newItems.slice(i, i + BATCH_SIZE);
      const texts = batch.map(item => prepareEmbeddingText(item));
      let embeddings: number[][];
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
      try {
        embeddings = await embedWithRetry(texts);
      } catch {
        // Batch failed after retries — try items individually, skip failures
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
          },
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
        store.upsert(storeItem);
      }

      embedded += batch.length;
      embedSpinner.text = `Embedding... ${embedded}/${allItems.length}`;
    }

    embedSpinner.succeed(`Embedded ${newItems.length} new items (${skipped} unchanged, ${allItems.length} total)`);

    const stats = store.getStats(repoFull);
    console.log(chalk.bold(`\nDatabase: ${stats.prs} PRs, ${stats.issues} issues, ${stats.diffs} cached diffs`));
    store.close();
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
    const config = loadConfig();
    const env = loadEnvConfig();
    const { owner, repo } = parseRepo(opts.repo || config.repo);
    const repoFull = `${owner}/${repo}`;
    const threshold = parseFloat(opts.threshold) || config.thresholds.duplicate_similarity;

    const store = new VectorStore();
    const items = store.getAllItems(repoFull) as unknown as PRItem[];
    const spinner = ora("Clustering duplicates...").start();

    const clusters = findDuplicateClusters(store, items, { threshold, repo: repoFull });
    spinner.succeed(`Found ${clusters.length} duplicate clusters`);

    if (opts.cluster) {
      const cluster = clusters.find(c => c.id === parseInt(opts.cluster));
      if (!cluster) {
        console.log(chalk.red(`Cluster #${opts.cluster} not found`));
        store.close();
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

      if (opts.diff) {
        console.log(chalk.dim("\n(Diff comparison requires fetching diffs — use `prism review <number>` for full analysis)"));
      }
    } else {
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
    }

    // Label actions
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

      if (opts.dryRun) {
        for (const a of applied.slice(0, 20)) {
          console.log(chalk.dim(`  ${a.action} "${a.label}" on #${a.number}: ${a.reason}`));
        }
        if (applied.length > 20) console.log(chalk.dim(`  ... and ${applied.length - 20} more`));
      }
    }

    store.close();
  });

// ── rank ────────────────────────────────────────────────────────
program
  .command("rank")
  .description("Score and rank PRs by quality signals")
  .option("-n, --top <number>", "Show top N results", "20")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("--apply-labels", "Apply top-pick labels")
  .action(async (opts) => {
    const config = loadConfig();
    const env = loadEnvConfig();
    const { owner, repo } = parseRepo(opts.repo || config.repo);
    const repoFull = `${owner}/${repo}`;

    const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    const store = new VectorStore();
    const items = store.getAllItems(repoFull) as unknown as PRItem[];

    const spinner = ora("Building scorer context...").start();
    const context = await buildScorerContext(items.slice(0, 100), github);
    spinner.succeed("Scorer context ready");

    const ranked = rankPRs(items, config, context);
    const top = ranked.slice(0, parseInt(opts.top) || 20);

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
    store.close();
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
    const config = loadConfig();
    const env = loadEnvConfig();
    const { owner, repo } = parseRepo(opts.repo || config.repo);
    const repoFull = `${owner}/${repo}`;
    let docPath = opts.doc || config.vision_doc;

    // Try local file first, then fetch from repo
    if (!docPath || !existsSync(docPath)) {
      const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
      const fetchSpinner = ora("Fetching vision document from repo...").start();

      // Try VISION.md first, then README.md
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
        fetchSpinner.fail("No vision document found locally or in repo (tried VISION.md, README.md)");
        return;
      }
    }

    const embedder = createEmbeddingProvider({
      provider: env.EMBEDDING_PROVIDER,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
    });
    const store = new VectorStore(undefined, embedder.dimensions);

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
      const table = new Table({
        head: ["#", "Score", "Matched Section"],
        colWidths: [8, 8, 50],
      });
      for (const s of offVision.slice(0, 20)) {
        table.push([s.prNumber, s.score.toFixed(2), s.matchedSection.slice(0, 48)]);
      }
      console.log(table.toString());
    }

    if (opts.applyLabels || opts.dryRun) {
      const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
      if (opts.applyLabels) await ensureLabelsExist(github, config);

      const actions: LabelAction[] = scores.map(s => ({
        number: s.prNumber,
        action: "add" as const,
        label: config.labels[s.classification === "off-vision" ? "off_vision" : s.classification],
        reason: `Vision score: ${s.score.toFixed(2)} → ${s.classification}`,
      }));

      await applyLabelActions(github, actions, opts.dryRun);
      console.log(chalk.green(`\n${opts.dryRun ? "Would apply" : "Applied"} ${actions.length} labels`));
    }

    store.close();
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
    const store = new VectorStore();

    const spinner = ora(`Fetching PR #${num}...`).start();
    const prs = await github.fetchPRs({ state: "all", maxItems: 5000 });
    const pr = prs.find(p => p.number === num);
    if (!pr) {
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
  .action(async (opts) => {
    console.log(chalk.bold("🔍 pr-prism triage\n"));

    // This delegates to the individual commands' logic
    // In a production version, you'd call the pipeline functions directly
    console.log(chalk.dim("Running: scan → dupes → rank → vision\n"));

    // Execute scan
    await program.parseAsync(["node", "prism", "scan", ...(opts.repo ? ["-r", opts.repo] : [])]);
    console.log();

    // Execute dupes
    const dupeArgs = ["node", "prism", "dupes", ...(opts.repo ? ["-r", opts.repo] : [])];
    if (opts.dryRun) dupeArgs.push("--dry-run");
    if (opts.applyLabels) dupeArgs.push("--apply-labels");
    await program.parseAsync(dupeArgs);
    console.log();

    // Execute rank
    await program.parseAsync(["node", "prism", "rank", ...(opts.repo ? ["-r", opts.repo] : [])]);
    console.log();

    // Execute vision (only if vision_doc exists)
    const config = loadConfig();
    if (config.vision_doc && existsSync(config.vision_doc)) {
      const visionArgs = ["node", "prism", "vision", ...(opts.repo ? ["-r", opts.repo] : [])];
      if (opts.dryRun) visionArgs.push("--dry-run");
      if (opts.applyLabels) visionArgs.push("--apply-labels");
      await program.parseAsync(visionArgs);
    } else {
      console.log(chalk.yellow("Skipping vision check — no vision doc configured"));
    }

    console.log(chalk.bold("\n✓ Triage complete"));
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

    const store = new VectorStore();
    const stats = store.getStats(repoFull);

    console.log(chalk.bold("pr-prism status\n"));
    console.log(`  Repo:     ${repoFull}`);
    console.log(`  PRs:      ${stats.prs}`);
    console.log(`  Issues:   ${stats.issues}`);
    console.log(`  Diffs:    ${stats.diffs} cached`);
    console.log(`  Total:    ${stats.totalItems} items\n`);

    // Check rate limit
    const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    try {
      await github.fetchPRs({ maxItems: 1 }); // Trigger rate limit update
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

// ── helpers ─────────────────────────────────────────────────────
function parseDuration(s: string): string {
  const match = s.match(/^(\d+)(d|w|m)$/);
  if (!match) throw new Error(`Invalid duration: ${s}. Use format like 7d, 2w, 1m`);
  const [, num, unit] = match;
  const days = unit === "d" ? parseInt(num) : unit === "w" ? parseInt(num) * 7 : parseInt(num) * 30;
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

program.parse();
