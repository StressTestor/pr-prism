import type { Command } from "commander";
import { createPipelineContext, runVision } from "../../pipeline.js";
import { validateJsonOutputMutex } from "../shared/validation.js";

export function registerVisionCommand(program: Command): void {
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
      validateJsonOutputMutex(opts);
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
}
