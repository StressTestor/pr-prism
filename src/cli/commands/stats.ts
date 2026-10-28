import chalk from "chalk";
import type { Command } from "commander";
import { loadEnvConfig, parseRepo } from "../../config.js";
import { GitHubClient } from "../../github.js";
import { resolveRepos } from "../../pipeline.js";
import { VectorStore } from "../../store.js";

export function registerStatsCommand(program: Command): void {
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
}
