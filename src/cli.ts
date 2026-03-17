#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import { findDuplicateClusters } from "./cluster.js";
import { getRepos, loadConfig, loadEnvConfig, parseRepo } from "./config.js";
import { createEmbeddingProvider, prepareEmbeddingText } from "./embeddings.js";
import { GitHubClient } from "./github.js";
import {
  createPipelineContext,
  resolveRepos,
  runCompare,
  runDupes,
  runDupesMulti,
  runRank,
  runScan,
  runVision,
} from "./pipeline.js";
import { reviewPR } from "./reviewer.js";
import { buildScorerContext, rankPRs } from "./scorer.js";
import { VectorStore } from "./store.js";
import type { PRItem } from "./types.js";
import { checkVisionAlignment } from "./vision.js";

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json");

const program = new Command();

program
  .name("prism")
  .description("BYOK GitHub PR/Issue triage tool — de-duplicate, rank, and vision-check PRs at scale")
  .version(pkg.version);

// Pipeline functions imported from ./pipeline.js:
// createPipelineContext, resolveRepos, runScan, runDupes, runDupesMulti, runRank, runVision, parseDuration

// ── init ────────────────────────────────────────────────────────
program
  .command("init")
  .description("Initialize pr-prism configuration in current directory")
  .action(async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const envExample = resolve(__dirname, "..", ".env.example");
    const configExample = resolve(__dirname, "..", "prism.config.yaml");

    if (!existsSync(".env") && existsSync(envExample)) {
      copyFileSync(envExample, ".env");
      console.log(`${chalk.green("✓")} Created .env (edit with your API keys)`);
    } else if (existsSync(".env")) {
      console.log(`${chalk.yellow("⊘")} .env already exists`);
    }

    if (!existsSync("prism.config.yaml") && existsSync(configExample)) {
      copyFileSync(configExample, "prism.config.yaml");
      console.log(`${chalk.green("✓")} Created prism.config.yaml (edit repo and settings)`);
    } else if (existsSync("prism.config.yaml")) {
      console.log(`${chalk.yellow("⊘")} prism.config.yaml already exists`);
    }

    // Full auto-detection of available providers
    let ollamaRunning = false;
    let ollamaEmbedModels: string[] = [];
    let ollamaLLMModels: string[] = [];
    const embeddingModelPrefixes = [
      "qwen3-embedding",
      "mxbai-embed",
      "all-minilm",
      "nomic-embed",
      "snowflake-arctic-embed",
    ];
    const llmModelPrefixes = ["llama", "qwen", "mistral", "gemma", "phi", "deepseek"];

    try {
      const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        ollamaRunning = true;
        const data = (await resp.json()) as any;
        const models: string[] = (data.models || []).map((m: any) => m.name as string);
        ollamaEmbedModels = models.filter((m) => embeddingModelPrefixes.some((p) => m.startsWith(p)));
        ollamaLLMModels = models.filter((m) => llmModelPrefixes.some((p) => m.startsWith(p)));
      }
    } catch {
      /* ollama not running */
    }

    // Detect API keys in environment
    const detectedKeys: Array<{ name: string; envVar: string; provider: string }> = [];
    const keyChecks = [
      { envVar: "JINA_API_KEY", name: "Jina", provider: "jina" },
      { envVar: "OPENAI_API_KEY", name: "OpenAI", provider: "openai" },
      { envVar: "VOYAGE_API_KEY", name: "Voyage AI", provider: "voyageai" },
      { envVar: "ANTHROPIC_API_KEY", name: "Anthropic", provider: "anthropic" },
      { envVar: "KIMI_API_KEY", name: "Kimi", provider: "kimi" },
    ];
    for (const check of keyChecks) {
      if (process.env[check.envVar]) detectedKeys.push(check);
    }

    console.log(`\n${chalk.bold("provider detection:")}`);

    // Embedding provider recommendation
    let bestEmbedding: { provider: string; model: string } | null = null;

    if (ollamaEmbedModels.length > 0) {
      const preferred = ollamaEmbedModels.find((m) => m.startsWith("qwen3-embedding")) || ollamaEmbedModels[0];
      console.log(chalk.green(`  embedding: ollama (${ollamaEmbedModels.join(", ")})`));
      bestEmbedding = { provider: "ollama", model: preferred };
    } else if (ollamaRunning) {
      console.log(chalk.yellow("  ollama running but no embedding model found"));
      console.log(chalk.dim("    recommended: ollama pull qwen3-embedding:0.6b"));
    }

    if (detectedKeys.length > 0) {
      for (const key of detectedKeys) {
        console.log(chalk.green(`  detected: ${key.name} (${key.envVar})`));
      }
      if (!bestEmbedding) {
        const jinaKey = detectedKeys.find((k) => k.provider === "jina");
        const openaiKey = detectedKeys.find((k) => k.provider === "openai");
        if (jinaKey) bestEmbedding = { provider: "jina", model: "jina-embeddings-v3" };
        else if (openaiKey) bestEmbedding = { provider: "openai", model: "text-embedding-3-small" };
      }
    }

    // LLM provider recommendation
    let bestLLM: { provider: string; model: string } | null = null;
    if (ollamaLLMModels.length > 0) {
      console.log(
        chalk.green(
          `  llm: ollama (${ollamaLLMModels.slice(0, 3).join(", ")}${ollamaLLMModels.length > 3 ? "..." : ""})`,
        ),
      );
      bestLLM = { provider: "ollama", model: ollamaLLMModels[0] };
    }
    // OpenCode Zen is always free, no key needed
    if (!bestLLM) {
      bestLLM = { provider: "opencode", model: "opencode/gpt-4o-mini" };
      console.log(chalk.green("  llm: opencode zen (free, no key needed)"));
    }

    if (!bestEmbedding && detectedKeys.length === 0 && !ollamaRunning) {
      console.log(chalk.yellow("  no providers detected"));
      console.log();
      console.log(chalk.bold("  zero-cost setup (recommended):"));
      console.log("  1. get a free Jina API key at https://jina.ai");
      console.log("  2. set EMBEDDING_PROVIDER=jina and EMBEDDING_API_KEY in .env");
      console.log("  3. LLM_PROVIDER=opencode works out of the box (free)");
      console.log();
      console.log(chalk.bold("  local setup (no API keys needed):"));
      console.log("  1. install ollama: https://ollama.com");
      console.log("  2. ollama pull qwen3-embedding:0.6b");
      console.log("  3. set EMBEDDING_PROVIDER=ollama in .env");
    }

    // Auto-fill .env with best detected provider
    if (bestEmbedding) {
      const envPath = resolve(process.cwd(), ".env");
      if (existsSync(envPath)) {
        let content = readFileSync(envPath, "utf-8");
        content = content.replace(/^EMBEDDING_PROVIDER=.*/m, `EMBEDDING_PROVIDER=${bestEmbedding.provider}`);
        content = content.replace(/^EMBEDDING_MODEL=.*/m, `EMBEDDING_MODEL=${bestEmbedding.model}`);
        if (bestLLM) {
          content = content.replace(/^LLM_PROVIDER=.*/m, `LLM_PROVIDER=${bestLLM.provider}`);
          content = content.replace(/^LLM_MODEL=.*/m, `LLM_MODEL=${bestLLM.model}`);
        }
        writeFileSync(envPath, content);
        console.log(
          chalk.dim(`\n  pre-filled .env with ${bestEmbedding.provider} + ${bestLLM?.provider || "opencode"}`),
        );
      }
    }

    // Check for GitHub token
    const hasGithubToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    if (hasGithubToken) {
      console.log(chalk.green("\n  detected: GitHub token in environment"));
    }

    console.log(`\n${chalk.bold("next steps:")}`);
    if (!hasGithubToken) {
      console.log("  1. Add your GitHub token to .env (GITHUB_TOKEN=ghp_...)");
      console.log("  2. Edit prism.config.yaml with your target repo");
      console.log("  3. Run: prism doctor && prism scan");
    } else {
      console.log("  1. Edit prism.config.yaml with your target repo");
      console.log("  2. Run: prism doctor && prism scan");
    }
  });

// ── doctor ──────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check configuration, providers, and database health")
  .option("--json", "Output results as JSON")
  .action(async (opts) => {
    const checks: Array<{ name: string; status: "pass" | "fail" | "warn"; detail: string }> = [];

    const pass = (name: string, detail: string) => checks.push({ name, status: "pass", detail });
    const fail = (name: string, detail: string) => checks.push({ name, status: "fail", detail });
    const warn = (name: string, detail: string) => checks.push({ name, status: "warn", detail });

    // 1. Config valid
    let config: ReturnType<typeof loadConfig> | null = null;
    try {
      config = loadConfig();
      const configRepos = getRepos(config);
      pass(
        "config",
        `prism.config.yaml valid (${configRepos.length} repo${configRepos.length > 1 ? "s" : ""}: ${configRepos.slice(0, 3).join(", ")}${configRepos.length > 3 ? "..." : ""})`,
      );
    } catch (e: any) {
      fail("config", e.message);
    }

    // 2. Env valid + GitHub token
    let env: ReturnType<typeof loadEnvConfig> | null = null;
    try {
      env = loadEnvConfig();
      pass("env", ".env loaded");
    } catch (e: any) {
      fail("env", e.message);
    }

    // 3. GitHub token works
    if (env && config) {
      try {
        const { owner, repo } = parseRepo(getRepos(config)[0]);
        const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
        await github.fetchPRs({ maxItems: 1 });
        const rl = github.getRateLimit();
        pass("github", `Token valid (${rl.remaining}/${rl.limit} API calls remaining)`);
      } catch (e: any) {
        if (e.status === 401) {
          fail("github", "Token invalid or expired. Generate at https://github.com/settings/tokens");
        } else if (e.status === 403) {
          fail("github", "Token lacks required scopes. Needs `repo` for private repos, `public_repo` for public");
        } else if (e.status === 404) {
          fail("github", `Repository ${getRepos(config)[0]} not found or not accessible with this token`);
        } else {
          fail("github", e.message || "Unknown error checking GitHub token");
        }
      }
    }

    // 4. Embedding provider reachable
    if (env) {
      try {
        const embedder = await createEmbeddingProvider({
          provider: env.EMBEDDING_PROVIDER,
          apiKey: env.EMBEDDING_API_KEY,
          model: env.EMBEDDING_MODEL,
        });
        pass("embedding", `${env.EMBEDDING_PROVIDER} (${env.EMBEDDING_MODEL}, ${embedder.dimensions} dims)`);
      } catch (e: any) {
        fail("embedding", e.remedy || e.message);
      }
    }

    // 5. LLM provider reachable (just check config, don't make a full call)
    if (env) {
      if (env.LLM_API_KEY || env.LLM_PROVIDER === "ollama" || env.LLM_PROVIDER === "opencode") {
        pass("llm", `${env.LLM_PROVIDER} (${env.LLM_MODEL})`);
      } else {
        warn("llm", `${env.LLM_PROVIDER} configured but no LLM_API_KEY set`);
      }
    }

    // 6. DB exists + sqlite-vec loads
    const dbPath = resolve(process.cwd(), "data", "prism.db");
    if (existsSync(dbPath)) {
      try {
        const store = new VectorStore(undefined, undefined);
        const firstRepo = config ? getRepos(config)[0] : "";
        const repoFull = firstRepo ? `${parseRepo(firstRepo).owner}/${parseRepo(firstRepo).repo}` : "";

        if (repoFull) {
          const stats = store.getStats(repoFull);
          pass(
            "database",
            `${stats.totalItems} items (${stats.prs} PRs, ${stats.issues} issues, ${stats.diffs} diffs)`,
          );

          // 7. Embedding dimensions + model match
          const storedModel = store.getMeta("embedding_model");
          const storedDims = store.getMeta("embedding_dimensions");
          const lastEmbed = store.getMeta("last_embed_date");

          if (storedModel && env && storedModel !== env.EMBEDDING_MODEL) {
            warn(
              "model",
              `DB has ${storedModel} but .env specifies ${env.EMBEDDING_MODEL}. Run \`prism re-embed\` to update`,
            );
          } else if (storedModel) {
            pass("model", `${storedModel} (${storedDims} dims)`);
          }

          if (lastEmbed) {
            pass("last_embed", `Last embedded: ${lastEmbed.slice(0, 10)}`);
          }

          // Embedding coverage
          const embeddedCount = store.getAllEmbeddings(repoFull).size;
          const coverage = stats.totalItems > 0 ? ((embeddedCount / stats.totalItems) * 100).toFixed(0) : "0";
          if (embeddedCount < stats.totalItems) {
            warn("coverage", `${embeddedCount}/${stats.totalItems} items embedded (${coverage}%)`);
          } else {
            pass("coverage", `${embeddedCount}/${stats.totalItems} items embedded (${coverage}%)`);
          }
        } else {
          pass("database", "Database exists and sqlite-vec loaded");
        }

        store.close();
      } catch (e: any) {
        fail("database", e.message);
      }
    } else {
      warn("database", "No database found. Run `prism scan` to create one");
    }

    // Output
    if (opts.json) {
      console.log(JSON.stringify({ command: "doctor", checks }));
      return;
    }

    console.log(chalk.bold("\nprism doctor\n"));
    for (const check of checks) {
      const icon =
        check.status === "pass" ? chalk.green("✓") : check.status === "fail" ? chalk.red("✗") : chalk.yellow("⚠");
      console.log(`  ${icon} ${check.name}: ${check.detail}`);
    }

    const failures = checks.filter((c) => c.status === "fail");
    const warnings = checks.filter((c) => c.status === "warn");
    console.log();
    if (failures.length === 0 && warnings.length === 0) {
      console.log(chalk.green("  all checks passed"));
    } else if (failures.length > 0) {
      console.log(chalk.red(`  ${failures.length} check(s) failed`));
    }
  });

// ── scan ────────────────────────────────────────────────────────
program
  .command("scan")
  .description("Ingest PRs and issues into local database")
  .option("-r, --repo <owner/repo>", "Repository to scan")
  .option("-s, --since <duration>", "Only fetch items updated within duration (e.g., 7d, 2w, 1m)")
  .option("--state <states>", "PR states to fetch (open, closed, all)", "open")
  .option("--rest", "Use REST API instead of GraphQL (no deep scan signals)")
  .option("--json", "Output results as NDJSON")
  .action(async (opts) => {
    const repos = resolveRepos(opts.repo);
    let store: VectorStore | null = null;
    try {
      for (const r of repos) {
        if (repos.length > 1) console.log(chalk.bold(`\n── ${r} ──`));
        const ctx = await createPipelineContext(r);
        store = ctx.store;
        await runScan(ctx, { since: opts.since, state: opts.state, useRest: opts.rest, json: opts.json });
      }
    } finally {
      store?.close();
    }
  });

// ── dupes ───────────────────────────────────────────────────────
program
  .command("dupes")
  .description("Find duplicate PR/issue clusters")
  .option("-t, --threshold <number>", "Similarity threshold", "0.85")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("--cluster <id>", "Show specific cluster details")
  .option("--apply-labels", "Apply labels to GitHub")
  .option("--dry-run", "Show what would be labeled without applying")
  .option("--json", "Output results as NDJSON")
  .option("--output <format>", "Output format: markdown")
  .action(async (opts) => {
    if (opts.json && opts.output) {
      console.error(chalk.red("Cannot use --json and --output together"));
      process.exit(1);
    }
    const repos = resolveRepos(opts.repo);
    const isMultiRepo = repos.length > 1;
    const ctx = await createPipelineContext(repos[0]);
    try {
      if (opts.cluster) {
        // Show specific cluster detail
        const items = isMultiRepo
          ? (ctx.store.getAllItemsMulti(repos) as unknown as PRItem[])
          : (ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[]);
        const threshold =
          opts.threshold !== undefined ? parseFloat(opts.threshold) : ctx.config.thresholds.duplicate_similarity;
        const clusters = findDuplicateClusters(ctx.store, items, {
          threshold,
          repo: isMultiRepo ? repos : ctx.repoFull,
        });
        const cluster = clusters.find((c) => c.id === parseInt(opts.cluster, 10));
        if (!cluster) {
          console.log(chalk.red(`Cluster #${opts.cluster} not found.`));
          if (clusters.length === 0) {
            console.log(chalk.dim("No clusters found at current threshold."));
          } else {
            const shown = clusters.slice(0, 20);
            const ids = shown.map((c) => `${c.id} (${c.items.length} items)`).join(", ");
            console.log(chalk.dim(`Available clusters: ${ids}`));
            if (clusters.length > 20) {
              console.log(chalk.dim(`  ... and ${clusters.length - 20} more (${clusters.length} total)`));
            }
          }
          return;
        }
        console.log(chalk.bold(`\nCluster #${cluster.id}: "${cluster.theme}"`));
        console.log(`Items: ${cluster.items.length} | Avg similarity: ${(cluster.avgSimilarity * 100).toFixed(1)}%\n`);
        for (const item of cluster.items) {
          const isBest = item.number === cluster.bestPick.number;
          const prefix = isBest ? chalk.green("★") : " ";
          const repoTag = isMultiRepo ? chalk.dim(`[${item.repo}] `) : "";
          console.log(`${prefix} ${repoTag}#${item.number} ${item.title}`);
          console.log(
            `  Author: ${item.author} | Updated: ${item.updatedAt.slice(0, 10)} | Score: ${item.score.toFixed(2)}`,
          );
        }
      } else {
        if (isMultiRepo) {
          await runDupesMulti(ctx, repos, {
            threshold: opts.threshold !== undefined ? parseFloat(opts.threshold) : undefined,
            applyLabels: opts.applyLabels,
            dryRun: opts.dryRun,
            json: opts.json,
            output: opts.output,
          });
        } else {
          await runDupes(ctx, {
            threshold: opts.threshold !== undefined ? parseFloat(opts.threshold) : undefined,
            applyLabels: opts.applyLabels,
            dryRun: opts.dryRun,
            json: opts.json,
            output: opts.output,
          });
        }
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
  .option("--explain", "Show signal breakdown per PR")
  .option("--json", "Output results as NDJSON")
  .option("-r, --repo <owner/repo>", "Repository")
  .action(async (opts) => {
    const ctx = await createPipelineContext(opts.repo);
    try {
      await runRank(ctx, { top: parseInt(opts.top, 10) || 20, explain: opts.explain, json: opts.json });
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
  .option("--json", "Output results as NDJSON")
  .option("--output <format>", "Output format: markdown")
  .option("--stats", "Show distribution histogram and section breakdown")
  .option("--detail", "Show per-item alignment detail")
  .action(async (opts) => {
    if (opts.json && opts.output) {
      console.error(chalk.red("Cannot use --json and --output together"));
      process.exit(1);
    }
    const ctx = await createPipelineContext(opts.repo);
    try {
      await runVision(ctx, {
        doc: opts.doc,
        applyLabels: opts.applyLabels,
        dryRun: opts.dryRun,
        json: opts.json,
        output: opts.output,
        stats: opts.stats,
        detail: opts.detail,
      });
    } finally {
      ctx.store.close();
    }
  });

// ── review ──────────────────────────────────────────────────────

function displayReview(
  num: number,
  title: string,
  result: { summary: string; concerns: string[]; recommendation: string; confidence: number },
  meta?: { author?: string; additions?: number; deletions?: number; provider?: string; model?: string },
) {
  console.log(chalk.bold(`\n  #${num}: ${title}`));
  if (meta?.author) console.log(`  Author: ${meta.author} | ${meta.additions ?? "?"}+/${meta.deletions ?? "?"}−`);
  if (meta?.provider) console.log(chalk.dim(`  Reviewed with ${meta.provider}/${meta.model}`));
  console.log();
  console.log(chalk.bold("  Summary:"), result.summary);
  if (result.concerns.length > 0) {
    console.log(chalk.bold("\n  Concerns:"));
    for (const c of result.concerns) {
      console.log(`    - ${c}`);
    }
  }
  const recColor =
    result.recommendation === "merge" ? chalk.green : result.recommendation === "revise" ? chalk.yellow : chalk.red;
  console.log(chalk.bold("\n  Recommendation:"), recColor(result.recommendation.toUpperCase()));
  console.log(chalk.bold("  Confidence:"), `${(result.confidence * 100).toFixed(0)}%`);
}

program
  .command("review [number]")
  .description("Deep LLM review of a PR or issue")
  .option("-m, --model <model>", "Override LLM model")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("-n, --top <number>", "Batch review top N ranked items")
  .option("--show <number>", "Show a previously saved review")
  .option("--type <type>", "Item type: pr or issue", "pr")
  .option("--json", "Output results as JSON")
  .action(async (numberArg: string | undefined, opts) => {
    const config = loadConfig();
    const env = loadEnvConfig();
    const repoStr = opts.repo || config.repo || getRepos(config)[0];
    const { owner, repo } = parseRepo(repoStr);
    const repoFull = `${owner}/${repo}`;

    const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    const embedder = await createEmbeddingProvider({
      provider: env.EMBEDDING_PROVIDER,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
    });
    const store = new VectorStore(undefined, embedder.dimensions, env.EMBEDDING_MODEL);

    try {
      // --show: display a saved review
      if (opts.show) {
        const num = parseInt(opts.show, 10);
        const saved = store.getReview(repoFull, num);
        if (!saved) {
          console.log(chalk.red(`No saved review for #${num}. Run \`prism review ${num}\` first.`));
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(saved));
        } else {
          displayReview(num, `(${saved.type})`, saved, { provider: saved.provider, model: saved.model });
        }
        return;
      }

      // --top N: batch review
      if (opts.top) {
        const topN = parseInt(opts.top, 10) || 5;
        const items = store.getAllItems(repoFull) as unknown as PRItem[];
        const filtered =
          opts.type === "issue" ? items.filter((i) => i.type === "issue") : items.filter((i) => i.type === "pr");
        const sorted = filtered
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .slice(0, topN);

        console.log(chalk.bold(`Reviewing top ${sorted.length} ${opts.type}s...\n`));
        for (const item of sorted) {
          const reviewSpinner = ora(`Reviewing #${item.number}...`).start();
          try {
            let result: import("./types.js").ReviewResult;
            if (item.type === "pr") {
              const diff = await github.fetchDiff(item.number, store);
              result = await reviewPR(item.title, item.body, diff, {
                provider: env.LLM_PROVIDER,
                apiKey: env.LLM_API_KEY,
                model: opts.model || env.LLM_MODEL,
              });
            } else {
              result = await reviewPR(item.title, item.body, "(no diff - this is an issue, not a PR)", {
                provider: env.LLM_PROVIDER,
                apiKey: env.LLM_API_KEY,
                model: opts.model || env.LLM_MODEL,
              });
            }
            store.saveReview(repoFull, item.number, item.type, env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
            reviewSpinner.succeed(`#${item.number} reviewed`);

            if (opts.json) {
              console.log(JSON.stringify({ number: item.number, type: item.type, ...result }));
            } else {
              displayReview(item.number, item.title, result, {
                author: item.author,
                additions: item.additions,
                deletions: item.deletions,
              });
            }
          } catch (e: any) {
            reviewSpinner.fail(`#${item.number} failed: ${e.message?.slice(0, 80)}`);
          }
        }
        return;
      }

      // Single review
      if (!numberArg) {
        console.error(chalk.red("Provide a PR/issue number, --top N for batch, or --show N for history"));
        process.exit(1);
      }

      const num = parseInt(numberArg, 10);
      const isIssue = opts.type === "issue";

      if (isIssue) {
        // Issue review
        const spinner = ora(`Fetching issue #${num}...`).start();
        const items = store.getAllItems(repoFull) as unknown as PRItem[];
        const issue = items.find((i) => i.number === num && i.type === "issue");
        if (!issue) {
          spinner.fail(`Issue #${num} not found in database. Run \`prism scan\` first.`);
          return;
        }
        spinner.succeed(`Loaded issue #${num}`);

        const reviewSpinner = ora(`Reviewing with ${opts.model || env.LLM_MODEL}...`).start();
        const result = await reviewPR(issue.title, issue.body, "(no diff - this is an issue, not a PR)", {
          provider: env.LLM_PROVIDER,
          apiKey: env.LLM_API_KEY,
          model: opts.model || env.LLM_MODEL,
        });
        store.saveReview(repoFull, num, "issue", env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
        reviewSpinner.succeed("Review complete");

        if (opts.json) {
          console.log(JSON.stringify({ number: num, type: "issue", ...result }));
        } else {
          displayReview(num, issue.title, result, { author: issue.author });
        }
      } else {
        // PR review
        const spinner = ora(`Fetching PR #${num}...`).start();
        let pr: PRItem;
        try {
          pr = await github.getPR(num);
        } catch {
          spinner.fail(`PR #${num} not found`);
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
        store.saveReview(repoFull, num, "pr", env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
        reviewSpinner.succeed("Review complete");

        if (opts.json) {
          console.log(JSON.stringify({ number: num, type: "pr", ...result }));
        } else {
          displayReview(num, pr.title, result, {
            author: pr.author,
            additions: pr.additions,
            deletions: pr.deletions,
          });
        }
      }
    } finally {
      store.close();
    }
  });

// ── triage ──────────────────────────────────────────────────────
program
  .command("triage")
  .description("Full pipeline: scan → dupes → rank → vision")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("--apply-labels", "Apply all labels")
  .option("--dry-run", "Show what would happen without applying")
  .option("-n, --top <number>", "Show top N ranked PRs", "20")
  .option("--rest", "Use REST API instead of GraphQL")
  .option("--output <format>", "Output format: markdown")
  .action(async (opts) => {
    if (opts.output && opts.output !== "markdown") {
      console.error(chalk.red(`Unknown output format: ${opts.output}. Supported: markdown`));
      process.exit(1);
    }
    const repos = resolveRepos(opts.repo);
    const isMultiRepo = repos.length > 1;
    console.log(chalk.bold("🔍 pr-prism triage\n"));
    if (isMultiRepo) {
      console.log(chalk.dim(`Running: scan → dupes → rank → vision across ${repos.length} repos\n`));
    } else {
      console.log(chalk.dim("Running: scan → dupes → rank → vision\n"));
    }

    let store: VectorStore | null = null;
    try {
      // Scan all repos
      for (const r of repos) {
        if (isMultiRepo) console.log(chalk.bold(`\n── scan: ${r} ──`));
        const ctx = await createPipelineContext(r);
        store = ctx.store;
        await runScan(ctx, { useRest: opts.rest });
      }
      console.log();

      // Dupes: cross-repo if multi
      const ctx = await createPipelineContext(repos[0]);
      store = ctx.store;
      if (isMultiRepo) {
        await runDupesMulti(ctx, repos, { applyLabels: opts.applyLabels, dryRun: opts.dryRun, output: opts.output });
      } else {
        await runDupes(ctx, { applyLabels: opts.applyLabels, dryRun: opts.dryRun, output: opts.output });
      }
      console.log();

      // Rank and vision per-repo
      for (const r of repos) {
        if (isMultiRepo) console.log(chalk.bold(`\n── ${r} ──`));
        const rCtx = await createPipelineContext(r);
        store = rCtx.store;
        await runRank(rCtx, { top: parseInt(opts.top, 10) || 20 });
        console.log();
        await runVision(rCtx, { applyLabels: opts.applyLabels, dryRun: opts.dryRun, output: opts.output });
      }
    } finally {
      store?.close();
    }

    console.log(chalk.bold("\n✓ Triage complete"));
  });

// ── compare ─────────────────────────────────────────────────────
program
  .command("compare <number1> <number2>")
  .description("Compare two PRs/issues for similarity")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("--json", "Output as JSON")
  .action(async (n1: string, n2: string, opts) => {
    const ctx = await createPipelineContext(opts.repo);
    try {
      await runCompare(ctx, parseInt(n1, 10), parseInt(n2, 10), { json: opts.json });
    } finally {
      ctx.store.close();
    }
  });

// ── reset ───────────────────────────────────────────────────────
program
  .command("reset")
  .description("Delete the local database and start fresh")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (opts) => {
    const dbPath = resolve(process.cwd(), "data", "prism.db");
    if (!existsSync(dbPath)) {
      console.log(chalk.yellow(`No database found at ${dbPath}`));
      return;
    }

    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
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
    console.log(`${chalk.green("✓")} Database deleted. Run \`prism scan\` to rebuild.`);
  });

// ── re-embed ─────────────────────────────────────────────────────
program
  .command("re-embed")
  .description("Re-embed all stored items with current embedding provider (no GitHub fetch)")
  .option("-r, --repo <owner/repo>", "Repository")
  .action(async (opts) => {
    const config = loadConfig();
    const env = loadEnvConfig();
    const repoStr = opts.repo || config.repo || getRepos(config)[0];
    const { owner, repo } = parseRepo(repoStr);
    const repoFull = `${owner}/${repo}`;

    const embedder = await createEmbeddingProvider({
      provider: env.EMBEDDING_PROVIDER,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
    });

    // open store without model check — we're intentionally changing models
    const store = new VectorStore(undefined, embedder.dimensions);
    const items = store.getAllItems(repoFull);

    if (items.length === 0) {
      console.log(chalk.red("no data found. run `prism scan` first."));
      store.close();
      return;
    }

    console.log(chalk.bold(`re-embedding ${items.length} items with ${env.EMBEDDING_MODEL}...`));

    // drop and recreate vec_items with new dimensions
    store.dropVecItems();
    store.initVecItems();

    const BATCH_SIZE = config.batch_size || (env.EMBEDDING_PROVIDER === "ollama" ? 50 : 10);
    const spinner = ora("Re-embedding...").start();
    let done = 0;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const texts = batch.map((item) =>
        prepareEmbeddingText({
          title: item.title,
          body: item.bodySnippet,
          type: item.type,
        }),
      );
      const embeddings = await embedder.embedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        store.upsertEmbeddingOnly(batch[j].id, new Float32Array(embeddings[j]));
      }
      done += batch.length;
      spinner.text = `Re-embedding... ${done}/${items.length}`;
    }

    // update meta
    store.setMeta("embedding_model", env.EMBEDDING_MODEL);
    store.setMeta("embedding_dimensions", String(embedder.dimensions));
    store.setMeta("schema_version", "1");

    spinner.succeed(`re-embedded ${items.length} items with ${env.EMBEDDING_MODEL}`);
    store.close();
  });

// ── stats (alias: status) ────────────────────────────────────────
for (const cmd of ["stats", "status"]) {
  program
    .command(cmd)
    .description("Show database stats, embedding coverage, and provider info")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--json", "Output results as NDJSON")
    .action(async (opts) => {
      const env = loadEnvConfig();
      const repos = resolveRepos(opts.repo);

      const store = new VectorStore(undefined, undefined);
      const embModel = store.getMeta("embedding_model") || "unknown";
      const embDims = store.getMeta("embedding_dimensions") || "?";
      const embProvider = store.getMeta("embedding_provider") || env.EMBEDDING_PROVIDER;
      const configHash = store.getMeta("embedding_config_hash") || "none";
      const lastEmbed = store.getMeta("last_embed_date");
      const lastCheckpoint = store.getMeta("embed_checkpoint");
      const lastTotal = store.getMeta("embed_total");

      console.log(chalk.bold("pr-prism stats\n"));

      for (const repoStr of repos) {
        const { owner, repo } = parseRepo(repoStr);
        const repoFull = `${owner}/${repo}`;
        const stats = store.getStats(repoFull);
        const embeddedCount = store.getAllEmbeddings(repoFull).size;
        const coverage = stats.totalItems > 0 ? ((embeddedCount / stats.totalItems) * 100).toFixed(0) : "0";

        if (repos.length > 1) console.log(chalk.bold(`  ── ${repoFull} ──`));
        console.log(`  Items:      ${stats.totalItems} (${stats.prs} PRs, ${stats.issues} issues)`);
        console.log(`  Diffs:      ${stats.diffs} cached`);
        console.log(`  Embeddings: ${embeddedCount}/${stats.totalItems} (${coverage}%)`);
        if (repos.length > 1) console.log();
      }

      console.log(`\n  Model:      ${embModel} (${embDims} dims)`);
      console.log(`  Provider:   ${embProvider}`);
      console.log(`  Config:     ${configHash}`);
      if (lastEmbed) console.log(`  Last embed: ${lastEmbed.slice(0, 10)}`);
      if (lastCheckpoint && lastTotal) console.log(`  Progress:   ${lastCheckpoint}/${lastTotal}`);
      console.log(`  LLM:        ${env.LLM_PROVIDER} (${env.LLM_MODEL})`);

      // API rate limit check
      const { owner, repo } = parseRepo(repos[0]);
      const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
      try {
        await github.fetchPRs({ maxItems: 1 });
        const rl = github.getRateLimit();
        const resetIn = Math.max(0, Math.ceil((rl.resetAt.getTime() - Date.now()) / 60000));
        console.log(`  API:        ${rl.remaining}/${rl.limit} remaining (resets in ${resetIn}min)`);
      } catch {
        console.log(chalk.yellow("  API:        Could not check rate limit"));
      }

      if (opts.json) {
        const allStats = repos.map((r) => {
          const { owner, repo } = parseRepo(r);
          const repoFull = `${owner}/${repo}`;
          return { repo: repoFull, ...store.getStats(repoFull) };
        });
        console.log(
          JSON.stringify({
            command: "stats",
            repos: allStats,
            embeddingModel: embModel,
            embeddingDimensions: embDims,
            embeddingProvider: embProvider,
            configHash,
            lastEmbed,
            llmProvider: env.LLM_PROVIDER,
            llmModel: env.LLM_MODEL,
          }),
        );
      }

      store.close();
    });
}

// ── report ──────────────────────────────────────────────────────
program
  .command("report")
  .description("Generate a markdown triage report")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("-o, --output <path>", "Output file path", "prism-report.md")
  .option("--top <number>", "Top N ranked PRs to include", "20")
  .option("--clusters <number>", "Top N duplicate clusters to include", "25")
  .option("--json", "Output report as JSON")
  .action(async (opts) => {
    const ctx = await createPipelineContext(opts.repo);
    const { config, repoFull, github, store, embedder } = ctx;
    const stats = store.getStats(repoFull);
    const items = store.getAllItems(repoFull) as unknown as PRItem[];

    if (items.length === 0) {
      console.log(chalk.red("no data found. run `prism scan` first."));
      store.close();
      return;
    }

    const spinner = ora("Generating report...").start();

    const clusters = findDuplicateClusters(store, items, {
      threshold: config.thresholds.duplicate_similarity,
      repo: repoFull,
    });
    const dupeItemCount = clusters.reduce((s, c) => s + c.items.length, 0);

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
          mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
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
        aligned: scores.filter((s) => s.classification === "aligned").length,
        drifting: scores.filter((s) => s.classification === "drifting").length,
        offVision: scores.filter((s) => s.classification === "off-vision").length,
      };
    }

    const topN = parseInt(opts.top, 10) || 20;
    const clusterN = parseInt(opts.clusters, 10) || 25;
    const now = new Date().toISOString().slice(0, 10);

    if (opts.json) {
      console.log(
        JSON.stringify({
          command: "report",
          repo: repoFull,
          date: now,
          stats,
          clusters: clusters.slice(0, clusterN).map((c) => ({
            id: c.id,
            size: c.items.length,
            avgSimilarity: c.avgSimilarity,
            bestPick: c.bestPick.number,
            theme: c.theme,
          })),
          ranked: ranked.slice(0, topN).map((pr) => ({
            number: pr.number,
            score: pr.score,
            author: pr.author,
            title: pr.title,
          })),
          vision: visionResults,
        }),
      );
      spinner.succeed("Report generated (JSON)");
      store.close();
      return;
    }

    let report = `# pr-prism triage report\n\n`;
    report += `**repo:** ${repoFull}  \n`;
    report += `**date:** ${now}  \n`;
    report += `**items scanned:** ${stats.totalItems} (${stats.prs} PRs, ${stats.issues} issues)\n\n`;

    report += `## overview\n\n`;
    report += `| metric | count |\n|--------|-------|\n`;
    report += `| open PRs scanned | ${stats.prs} |\n`;
    report += `| open issues scanned | ${stats.issues} |\n`;
    report += `| duplicate clusters | ${clusters.length} |\n`;
    report += `| items in duplicate clusters | ${dupeItemCount} (${((dupeItemCount / stats.totalItems) * 100).toFixed(0)}% of total) |\n`;
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

    const bigClusters = clusters.filter((c) => c.items.length >= 10).slice(0, 10);
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

// Only parse when run directly as CLI — allows importing pipeline functions
const isDirectRun =
  process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.includes("prism");

if (isDirectRun) {
  program.parse();
}

export { program };
