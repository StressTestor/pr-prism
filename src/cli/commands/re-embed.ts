import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { getRepos, loadConfig, loadEnvConfig, parseRepo } from "../../config.js";
import { createEmbeddingProvider } from "../../embeddings.js";
import { reEmbedStoredItems } from "../../pipeline.js";
import { VectorStore } from "../../store.js";

export function registerReEmbedCommand(program: Command): void {
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
        baseUrl: env.EMBEDDING_BASE_URL,
        dimensions: env.EMBEDDING_DIMENSIONS,
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

      const BATCH_SIZE = config.batch_size || (env.EMBEDDING_PROVIDER === "ollama" ? 50 : 10);
      const spinner = ora("Re-embedding...").start();
      await reEmbedStoredItems(
        store,
        items,
        embedder,
        {
          provider: env.EMBEDDING_PROVIDER,
          model: env.EMBEDDING_MODEL,
          baseUrl: env.EMBEDDING_BASE_URL,
          dimensions: env.EMBEDDING_DIMENSIONS,
        },
        BATCH_SIZE,
        (done, total) => {
          spinner.text = `Re-embedding... ${done}/${total}`;
        },
      );

      spinner.succeed(`re-embedded ${items.length} items with ${env.EMBEDDING_MODEL}`);
      store.close();
    });
}
