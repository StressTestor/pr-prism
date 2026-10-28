import type { Command } from "commander";
import { createPipelineContext, runCompare } from "../../pipeline.js";

export function registerCompareCommand(program: Command): void {
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
}
