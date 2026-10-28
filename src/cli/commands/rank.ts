import type { Command } from "commander";
import { createPipelineContext, runRank } from "../../pipeline.js";

export function registerRankCommand(program: Command): void {
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
}
