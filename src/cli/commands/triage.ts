import chalk from "chalk";
import type { Command } from "commander";
import {
  createPipelineContext,
  resolveRepos,
  runDupes,
  runDupesMulti,
  runRank,
  runScan,
  runVision,
} from "../../pipeline.js";
import type { VectorStore } from "../../store.js";

export function registerTriageCommand(program: Command): void {
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
          store?.close();
          store = ctx.store;
          await runScan(ctx, { useRest: opts.rest });
        }
        console.log();

        // Dupes: cross-repo if multi
        store?.close();
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
          store?.close();
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
}
