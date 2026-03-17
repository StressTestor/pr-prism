import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import { findDuplicateClusters } from "./cluster.js";
import { getRepos, getVisionDoc, loadConfig, loadEnvConfig, parseRepo } from "./config.js";
import { createEmbeddingProvider, prepareEmbeddingText } from "./embeddings.js";
import { GitHubClient } from "./github.js";
import { applyLabelActions, ensureLabelsExist, type LabelAction } from "./labels.js";
import { buildScorerContext, rankPRs } from "./scorer.js";
import { cosineSimilarity, isZeroVector } from "./similarity.js";
import { VectorStore } from "./store.js";
import type { EmbeddingProvider, PipelineContext, PRItem, StoreItem } from "./types.js";
import { checkVisionAlignment } from "./vision.js";

export type { PipelineContext };

// ── helpers ─────────────────────────────────────────────────────
export function parseDuration(s: string): string {
  const match = s.match(/^(\d+)(d|w|m)$/);
  if (!match) throw new Error(`Invalid duration: ${s}. Use format like 7d, 2w, 1m`);
  const [, num, unit] = match;
  const days = unit === "d" ? parseInt(num, 10) : unit === "w" ? parseInt(num, 10) * 7 : parseInt(num, 10) * 30;
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

export function resolveRepos(repoOverride?: string): string[] {
  if (repoOverride) return [repoOverride];
  const config = loadConfig();
  return getRepos(config).map((r) => {
    const { owner, repo } = parseRepo(r);
    return `${owner}/${repo}`;
  });
}

// ── pipeline functions (used by individual commands and triage) ──

export async function createPipelineContext(repoOverride?: string): Promise<PipelineContext> {
  const config = loadConfig();
  const env = loadEnvConfig();
  const repoStr = repoOverride || config.repo || getRepos(config)[0];
  const { owner, repo } = parseRepo(repoStr);
  const repoFull = `${owner}/${repo}`;
  const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
  const embedder = await createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    apiKey: env.EMBEDDING_API_KEY,
    model: env.EMBEDDING_MODEL,
  });
  // Matryoshka dimension truncation
  const targetDims = env.EMBEDDING_DIMENSIONS;
  if (targetDims && targetDims > embedder.dimensions) {
    throw new Error(
      `EMBEDDING_DIMENSIONS (${targetDims}) exceeds model's native dimensions (${embedder.dimensions}). ` +
        `use a value <= ${embedder.dimensions} or remove EMBEDDING_DIMENSIONS.`,
    );
  }
  const effectiveDims = targetDims || embedder.dimensions;

  // Wrap embedder to truncate if needed
  const wrappedEmbedder =
    targetDims && targetDims < embedder.dimensions
      ? {
          dimensions: targetDims,
          embed: async (text: string) => {
            const full = await embedder.embed(text);
            return full.slice(0, targetDims);
          },
          embedBatch: async (texts: string[]) => {
            const full = await embedder.embedBatch(texts);
            return full.map((v) => v.slice(0, targetDims));
          },
          init: () => Promise.resolve(),
        }
      : embedder;

  const store = new VectorStore(undefined, effectiveDims, env.EMBEDDING_MODEL);
  return { config, env, owner, repo, repoFull, github, store, embedder: wrappedEmbedder as EmbeddingProvider };
}

export async function runScan(
  ctx: PipelineContext,
  opts: { since?: string; state?: string; useRest?: boolean; json?: boolean },
) {
  const { config, env, repoFull, github, store } = ctx;
  const since = opts.since ? parseDuration(opts.since) : undefined;
  const stateArg = opts.state || "open";
  const states = (stateArg === "all" ? "open,closed" : stateArg).split(",") as Array<"open" | "closed">;

  const allItems: PRItem[] = [];

  if (opts.useRest) {
    // REST fallback — no deep scan signals
    const rateLimitWarning = github.formatRateLimitWarning(config.max_prs);
    if (rateLimitWarning) console.log(chalk.yellow(rateLimitWarning));

    for (const state of states) {
      const spinner = ora(`Fetching ${state} PRs from ${repoFull} (REST)...`).start();
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
      const issues = await github.fetchIssues({ since, state, maxItems: config.max_prs, batchSize: config.batch_size });
      issueSpinner.succeed(`Fetched ${issues.length} ${state} issues`);

      allItems.push(...prs, ...issues);
    }
  } else {
    // GraphQL — gets CI, reviews, test files inline
    for (const state of states) {
      const spinner = ora(`Fetching ${state} PRs from ${repoFull} (GraphQL)...`).start();
      const prs = await github.fetchPRsGraphQL({
        since,
        state,
        maxItems: config.max_prs,
        onProgress: (fetched, total) => {
          spinner.text = `Fetching ${state} PRs... ${fetched}/${total}`;
        },
      });
      spinner.succeed(`Fetched ${prs.length} ${state} PRs (with CI, reviews, tests)`);

      const issueSpinner = ora(`Fetching ${state} issues...`).start();
      const issues = await github.fetchIssuesGraphQL({
        since,
        state,
        maxItems: config.max_prs,
        onProgress: (fetched, total) => {
          issueSpinner.text = `Fetching ${state} issues... ${fetched}/${total}`;
        },
      });
      issueSpinner.succeed(`Fetched ${issues.length} ${state} issues`);

      allItems.push(...prs, ...issues);
    }
  }

  const rl = github.getRateLimit();
  console.log(chalk.dim(`API budget: ${rl.remaining}/${rl.limit} remaining`));

  // Filter unchanged — also detect items with missing embeddings (crash recovery)
  const newItems: PRItem[] = [];
  let skipped = 0;
  let recovered = 0;
  for (const item of allItems) {
    const existing = store.getByNumber(repoFull, item.number);
    if (existing && existing.updatedAt === item.updatedAt) {
      // Check if embedding actually exists (crash recovery)
      const hasEmbedding = store.getEmbedding(existing.id);
      if (hasEmbedding) {
        skipped++;
      } else {
        recovered++;
        newItems.push(item);
      }
    } else {
      newItems.push(item);
    }
  }

  if (skipped > 0 || recovered > 0) {
    let msg = `Skipping ${skipped} unchanged items`;
    if (recovered > 0) {
      msg += chalk.yellow(`, resuming ${recovered} items with missing embeddings`);
    }
    msg += `, embedding ${newItems.length} new/updated`;
    console.log(chalk.dim(msg));
  }

  // Embed and store
  const { embedder } = ctx;

  // Store/update embedding metadata on every scan
  const configHash = `${env.EMBEDDING_PROVIDER}:${env.EMBEDDING_MODEL}:${embedder.dimensions}`;
  const storedHash = store.getMeta("embedding_config_hash");
  if (storedHash && storedHash !== configHash && newItems.length > 0) {
    console.log(
      chalk.yellow(
        `  warning: embedding config changed (was ${storedHash}, now ${configHash}). ` +
          "run `prism scan --reset-embeddings` or `prism reset` if results look wrong.",
      ),
    );
  }
  store.setMeta("embedding_model", env.EMBEDDING_MODEL);
  store.setMeta("embedding_dimensions", String(embedder.dimensions));
  store.setMeta("embedding_provider", env.EMBEDDING_PROVIDER);
  store.setMeta("embedding_config_hash", configHash);
  store.setMeta("schema_version", "1");

  const embedSpinner = ora(`Embedding ${newItems.length} items...`).start();
  const BATCH_SIZE = config.batch_size || (env.EMBEDDING_PROVIDER === "ollama" ? 50 : 10);
  let embedded = 0;
  let zeroVectors = 0;

  for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
    const batch = newItems.slice(i, i + BATCH_SIZE);
    const texts = batch.map((item) => prepareEmbeddingText(item));
    const embedWithRetry = async (input: string[]): Promise<number[][]> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await embedder.embedBatch(input);
        } catch (e: any) {
          const msg = e.message || "";
          if (msg.includes("429")) {
            const wait = 60 * (attempt + 1);
            embedSpinner.text = `Rate limited, waiting ${wait}s... (${embedded}/${newItems.length})`;
            await new Promise((r) => setTimeout(r, wait * 1000));
          } else if (attempt < 2) {
            embedSpinner.text = `Error (${msg.slice(0, 60)}), retry ${attempt + 1}/3... (${embedded}/${newItems.length})`;
            await new Promise((r) => setTimeout(r, 5000));
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
      const embedding = new Float32Array(embeddings[j]);

      // Detect zero-vector failures
      const isZero = embedding.every((v) => v === 0);
      if (isZero) zeroVectors++;

      const storeItem: StoreItem = {
        id: `${repoFull}:${item.type}:${item.number}`,
        type: item.type,
        number: item.number,
        repo: repoFull,
        title: item.title,
        bodySnippet: item.body.slice(0, 500),
        embedding,
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
          bodyLength: item.body.length,
        },
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      // Per-item commit — crash-safe, already-embedded items persist
      store.upsert(storeItem);
    }

    embedded += batch.length;
    store.setMeta("embed_checkpoint", String(embedded));
    store.setMeta("embed_total", String(newItems.length));
    embedSpinner.text = `Embedding... ${embedded}/${newItems.length}`;
  }

  store.setMeta("last_embed_date", new Date().toISOString());

  let embedMsg = `Embedded ${newItems.length} new items (${skipped} unchanged, ${allItems.length} total)`;
  if (zeroVectors > 0) {
    embedMsg += chalk.yellow(` (${zeroVectors} failed with zero vectors — excluded from clustering)`);
  }
  embedSpinner.succeed(embedMsg);

  const stats = store.getStats(repoFull);

  if (opts.json) {
    console.log(
      JSON.stringify({
        command: "scan",
        repo: repoFull,
        newItems: newItems.length,
        skipped,
        total: allItems.length,
        ...stats,
      }),
    );
  } else {
    console.log(chalk.bold(`\nDatabase: ${stats.prs} PRs, ${stats.issues} issues, ${stats.diffs} cached diffs`));
  }
}

export async function runDupes(
  ctx: PipelineContext,
  opts: { threshold?: number; applyLabels?: boolean; dryRun?: boolean; json?: boolean; output?: string },
) {
  const { config, env, owner, repo, repoFull, store } = ctx;
  const threshold = opts.threshold ?? config.thresholds.duplicate_similarity;
  const items = store.getAllItems(repoFull) as unknown as PRItem[];

  if (items.length === 0) {
    console.log(chalk.red("no data found. run `prism scan` first."));
    return [];
  }

  const spinner = ora("Clustering duplicates...").start();

  const clusters = findDuplicateClusters(store, items, { threshold, repo: repoFull });
  spinner.succeed(`Found ${clusters.length} duplicate clusters`);

  if (opts.json) {
    for (const c of clusters) {
      console.log(
        JSON.stringify({
          id: c.id,
          size: c.items.length,
          avgSimilarity: c.avgSimilarity,
          bestPick: c.bestPick.number,
          theme: c.theme,
          items: c.items.map((i) => ({ number: i.number, type: i.type, title: i.title, score: i.score })),
        }),
      );
    }
    return clusters;
  }

  if (opts.output === "markdown") {
    let md = `## duplicate clusters\n\n`;
    md += `| # | Size | Avg Sim | Best Pick | Theme |\n`;
    md += `|---|------|---------|-----------|-------|\n`;
    for (const c of clusters) {
      const theme = c.theme.replace(/\|/g, "\\|").slice(0, 60);
      md += `| ${c.id} | ${c.items.length} | ${(c.avgSimilarity * 100).toFixed(1)}% | #${c.bestPick.number} | ${theme} |\n`;
    }
    md += `\nTotal: ${clusters.reduce((s, c) => s + c.items.length, 0)} items across ${clusters.length} clusters\n`;
    console.log(md);
    return clusters;
  }

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
  console.log(
    chalk.dim(`\nTotal: ${clusters.reduce((s, c) => s + c.items.length, 0)} items across ${clusters.length} clusters`),
  );

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

export async function runDupesMulti(
  ctx: PipelineContext,
  repos: string[],
  opts: { threshold?: number; applyLabels?: boolean; dryRun?: boolean; json?: boolean; output?: string },
) {
  const { config, store } = ctx;
  const threshold = opts.threshold ?? config.thresholds.duplicate_similarity;
  const items = store.getAllItemsMulti(repos) as unknown as PRItem[];

  if (items.length === 0) {
    console.log(chalk.red("no data found. run `prism scan` first."));
    return [];
  }

  const spinner = ora(`Clustering duplicates across ${repos.length} repos...`).start();
  const clusters = findDuplicateClusters(store, items, { threshold, repo: repos });
  spinner.succeed(`Found ${clusters.length} duplicate clusters across ${repos.length} repos`);

  // Count cross-repo clusters
  const crossRepoClusters = clusters.filter((c) => {
    const clusterRepos = new Set(c.items.map((i) => i.repo));
    return clusterRepos.size > 1;
  });
  if (crossRepoClusters.length > 0) {
    console.log(chalk.cyan(`  ${crossRepoClusters.length} cross-repo clusters detected`));
  }

  if (opts.json) {
    for (const c of clusters) {
      console.log(
        JSON.stringify({
          id: c.id,
          size: c.items.length,
          avgSimilarity: c.avgSimilarity,
          bestPick: { number: c.bestPick.number, repo: c.bestPick.repo },
          theme: c.theme,
          crossRepo: new Set(c.items.map((i) => i.repo)).size > 1,
          items: c.items.map((i) => ({ number: i.number, repo: i.repo, type: i.type, title: i.title, score: i.score })),
        }),
      );
    }
    return clusters;
  }

  if (opts.output === "markdown") {
    let md = `## duplicate clusters (${repos.length} repos)\n\n`;
    md += `| # | Size | Avg Sim | Best Pick | Theme |\n`;
    md += `|---|------|---------|-----------|-------|\n`;
    for (const c of clusters) {
      const theme = c.theme.replace(/\|/g, "\\|").slice(0, 60);
      const bestLabel = `[${c.bestPick.repo}] #${c.bestPick.number}`;
      md += `| ${c.id} | ${c.items.length} | ${(c.avgSimilarity * 100).toFixed(1)}% | ${bestLabel} | ${theme} |\n`;
    }
    md += `\nTotal: ${clusters.reduce((s, c) => s + c.items.length, 0)} items across ${clusters.length} clusters\n`;
    if (crossRepoClusters.length > 0) {
      md += `Cross-repo clusters: ${crossRepoClusters.length}\n`;
    }
    console.log(md);
    return clusters;
  }

  const table = new Table({
    head: ["#", "Size", "Avg Sim", "Best Pick", "Theme"],
    colWidths: [6, 6, 10, 30, 40],
  });

  for (const cluster of clusters) {
    const bestLabel = `[${cluster.bestPick.repo}] #${cluster.bestPick.number}`;
    table.push([
      cluster.id,
      cluster.items.length,
      `${(cluster.avgSimilarity * 100).toFixed(1)}%`,
      bestLabel,
      cluster.theme.slice(0, 38),
    ]);
  }

  console.log(table.toString());
  console.log(
    chalk.dim(`\nTotal: ${clusters.reduce((s, c) => s + c.items.length, 0)} items across ${clusters.length} clusters`),
  );

  // Labels need per-repo GitHub clients
  if (opts.applyLabels || opts.dryRun) {
    const env = ctx.env;
    for (const repoStr of repos) {
      const { owner, repo } = parseRepo(repoStr);
      const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
      if (opts.applyLabels) await ensureLabelsExist(github, config);

      const actions: LabelAction[] = [];
      for (const cluster of clusters) {
        for (const item of cluster.items.filter((i) => i.repo === repoStr)) {
          actions.push({
            number: item.number,
            action: "add",
            label: config.labels.duplicate,
            reason: `Cluster #${cluster.id} (${cluster.items.length} items)`,
          });
        }
        if (cluster.bestPick.repo === repoStr) {
          actions.push({
            number: cluster.bestPick.number,
            action: "add",
            label: config.labels.top_pick,
            reason: `Best pick in cluster #${cluster.id}`,
          });
        }
      }

      if (actions.length > 0) {
        const applied = await applyLabelActions(github, actions, opts.dryRun);
        const verb = opts.dryRun ? "Would apply" : "Applied";
        console.log(chalk.green(`\n${verb} ${applied.length} labels on ${repoStr}`));
      }
    }
  }

  return clusters;
}

export async function runRank(ctx: PipelineContext, opts: { top?: number; explain?: boolean; json?: boolean }) {
  const { config, repoFull, github, store } = ctx;
  const items = store.getAllItems(repoFull) as unknown as PRItem[];

  if (items.length === 0) {
    console.log(chalk.red("no data found. run `prism scan` first."));
    return [];
  }

  const spinner = ora("Building scorer context...").start();
  const context = await buildScorerContext(items, github, store, repoFull);
  spinner.succeed("Scorer context ready");

  const ranked = rankPRs(items, config, context);
  const top = ranked.slice(0, opts.top || 20);

  if (opts.json) {
    for (const pr of top) {
      console.log(
        JSON.stringify({
          number: pr.number,
          type: pr.type,
          score: pr.score,
          author: pr.author,
          title: pr.title,
          signals: pr.signals,
        }),
      );
    }
    return ranked;
  }

  const table = new Table({
    head: ["Rank", "#", "Score", "Author", "Title"],
    colWidths: [6, 8, 8, 16, 50],
  });

  top.forEach((pr, i) => {
    table.push([i + 1, pr.number, pr.score.toFixed(2), (pr.author || "unknown").slice(0, 14), pr.title.slice(0, 48)]);
  });

  console.log(table.toString());

  if (opts.explain) {
    const weights = config.scoring.weights;
    console.log(chalk.bold("\nsignal breakdown:\n"));
    const explainTable = new Table({
      head: ["#", "Tests", "CI", "Diff", "Author", "Desc", "Reviews", "Recency", "Total"],
      colWidths: [8, 8, 8, 8, 8, 8, 8, 8, 8],
    });
    for (const pr of top) {
      const s = pr.signals;
      const hasDiff = s.diffSize >= 0;
      explainTable.push([
        pr.number,
        (s.hasTests * weights.has_tests).toFixed(2),
        (s.ciPassing * weights.ci_passing).toFixed(2),
        hasDiff ? (s.diffSize * weights.diff_size_penalty).toFixed(2) : "n/a",
        (s.authorHistory * weights.author_history).toFixed(2),
        (s.descriptionQuality * weights.description_quality).toFixed(2),
        (s.reviewApprovals * weights.review_approvals).toFixed(2),
        (s.recency * 0.05).toFixed(2),
        pr.score.toFixed(2),
      ]);
    }
    console.log(explainTable.toString());
  }

  return ranked;
}

export async function runVision(
  ctx: PipelineContext,
  opts: {
    doc?: string;
    applyLabels?: boolean;
    dryRun?: boolean;
    json?: boolean;
    output?: string;
    stats?: boolean;
    detail?: boolean;
  },
) {
  const { config, env, owner, repo, repoFull, github, store } = ctx;
  let docPath = opts.doc || getVisionDoc(config, repoFull);

  if (!docPath || !existsSync(docPath)) {
    const fetchSpinner = ora("Fetching vision document from repo...").start();
    for (const candidate of ["VISION.md", "README.md"]) {
      const content = await github.fetchFileContent(candidate);
      if (content) {
        const localPath = resolve(process.cwd(), "data", candidate);
        mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
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

  const spinner = ora("Checking vision alignment...").start();
  const scores = await checkVisionAlignment(store, ctx.embedder, config, docPath, repoFull);
  spinner.succeed("Vision alignment checked");

  if (opts.json) {
    for (const s of scores) {
      console.log(JSON.stringify(s));
    }
    return scores;
  }

  const aligned = scores.filter((s) => s.classification === "aligned");
  const drifting = scores.filter((s) => s.classification === "drifting");
  const offVision = scores.filter((s) => s.classification === "off-vision");

  if (opts.output === "markdown") {
    let md = `## vision alignment\n\n`;
    md += `- **Aligned:** ${aligned.length}\n`;
    md += `- **Drifting:** ${drifting.length}\n`;
    md += `- **Off-vision:** ${offVision.length}\n`;
    if (offVision.length > 0) {
      md += `\n### off-vision items\n\n`;
      md += `| # | Score | Matched Section |\n`;
      md += `|---|-------|-----------------|\n`;
      for (const s of offVision.slice(0, 20)) {
        md += `| #${s.prNumber} | ${s.score.toFixed(2)} | ${s.matchedSection.replace(/\|/g, "\\|").slice(0, 60)} |\n`;
      }
    }
    console.log(md);
    return scores;
  }

  console.log(chalk.green(`  Aligned: ${aligned.length}`));
  console.log(chalk.yellow(`  Drifting: ${drifting.length}`));
  console.log(chalk.red(`  Off-vision: ${offVision.length}`));

  // Stats: histogram and section breakdown
  if (opts.stats) {
    const total = scores.length;
    const pctAligned = ((aligned.length / total) * 100).toFixed(0);
    const pctDrifting = ((drifting.length / total) * 100).toFixed(0);
    const pctOff = ((offVision.length / total) * 100).toFixed(0);
    const barWidth = 40;
    const barA = chalk.green("█".repeat(Math.round((aligned.length / total) * barWidth)));
    const barD = chalk.yellow("█".repeat(Math.round((drifting.length / total) * barWidth)));
    const barO = chalk.red("█".repeat(Math.round((offVision.length / total) * barWidth)));

    console.log(chalk.bold("\n  distribution:"));
    console.log(`  aligned  ${barA} ${pctAligned}% (${aligned.length})`);
    console.log(`  drifting ${barD} ${pctDrifting}% (${drifting.length})`);
    console.log(`  off      ${barO} ${pctOff}% (${offVision.length})`);

    // Section breakdown
    const sectionCounts = new Map<string, { aligned: number; drifting: number; off: number }>();
    for (const s of scores) {
      const section = s.matchedSection || "(no match)";
      const entry = sectionCounts.get(section) || { aligned: 0, drifting: 0, off: 0 };
      if (s.classification === "aligned") entry.aligned++;
      else if (s.classification === "drifting") entry.drifting++;
      else entry.off++;
      sectionCounts.set(section, entry);
    }

    if (sectionCounts.size > 0) {
      console.log(chalk.bold("\n  section breakdown:"));
      const sectionTable = new Table({
        head: ["Section", "Aligned", "Drifting", "Off"],
        colWidths: [40, 10, 10, 10],
      });
      const sorted = [...sectionCounts.entries()].sort(
        (a, b) => b[1].aligned + b[1].drifting + b[1].off - (a[1].aligned + a[1].drifting + a[1].off),
      );
      for (const [section, counts] of sorted.slice(0, 15)) {
        sectionTable.push([section.slice(0, 38), counts.aligned, counts.drifting, counts.off]);
      }
      console.log(sectionTable.toString());
    }
  }

  // Detail: per-item table
  if (opts.detail) {
    console.log(chalk.bold("\n  per-item detail:"));
    const detailTable = new Table({
      head: ["#", "Score", "Status", "Matched Section"],
      colWidths: [8, 8, 12, 50],
    });
    const statusColor = (c: string) =>
      c === "aligned" ? chalk.green(c) : c === "drifting" ? chalk.yellow(c) : chalk.red(c);
    for (const s of scores.slice(0, 50)) {
      detailTable.push([s.prNumber, s.score.toFixed(2), statusColor(s.classification), s.matchedSection.slice(0, 48)]);
    }
    console.log(detailTable.toString());
    if (scores.length > 50) {
      console.log(chalk.dim(`  ... and ${scores.length - 50} more (${scores.length} total)`));
    }
  }

  if (offVision.length > 0 && !opts.detail) {
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

    const actions: LabelAction[] = scores.map((s) => ({
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

export async function runCompare(
  ctx: PipelineContext,
  number1: number,
  number2: number,
  opts: { json?: boolean },
): Promise<{ similarity: number; item1: any; item2: any } | null> {
  const { repoFull, store } = ctx;

  const item1 = store.getByNumber(repoFull, number1);
  const item2 = store.getByNumber(repoFull, number2);

  if (!item1) {
    console.log(chalk.red(`#${number1} not found in database. Run \`prism scan\` first.`));
    return null;
  }
  if (!item2) {
    console.log(chalk.red(`#${number2} not found in database. Run \`prism scan\` first.`));
    return null;
  }

  const emb1 = store.getEmbedding(item1.id);
  const emb2 = store.getEmbedding(item2.id);

  if (!emb1 || !emb2) {
    console.log(chalk.red("One or both items have no embeddings. Run `prism scan` first."));
    return null;
  }

  if (isZeroVector(emb1) || isZeroVector(emb2)) {
    console.log(chalk.yellow("One or both items have zero-vector embeddings (failed embedding). Cannot compare."));
    return null;
  }

  const similarity = cosineSimilarity(emb1, emb2);

  if (opts.json) {
    console.log(
      JSON.stringify({
        command: "compare",
        similarity,
        item1: { number: number1, type: item1.type, title: item1.title },
        item2: { number: number2, type: item2.type, title: item2.title },
      }),
    );
  } else {
    console.log(chalk.bold(`\nComparing #${number1} vs #${number2}\n`));
    console.log(`  #${number1}: ${item1.title}`);
    console.log(`  #${number2}: ${item2.title}`);
    console.log();

    const simPct = (similarity * 100).toFixed(1);
    const color = similarity >= 0.85 ? chalk.red : similarity >= 0.65 ? chalk.yellow : chalk.green;
    console.log(`  Similarity: ${color(`${simPct}%`)}`);

    if (similarity >= 0.85) {
      console.log(chalk.red("  → Likely duplicates"));
    } else if (similarity >= 0.65) {
      console.log(chalk.yellow("  → Related but distinct"));
    } else {
      console.log(chalk.green("  → Unrelated"));
    }
  }

  return { similarity, item1, item2 };
}
