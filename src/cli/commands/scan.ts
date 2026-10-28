import chalk from "chalk";
import type { Command } from "commander";
import { createPipelineContext, resolveRepos, runScan } from "../../pipeline.js";
import type { VectorStore } from "../../store.js";

export function registerScanCommand(program: Command): void {
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
}
