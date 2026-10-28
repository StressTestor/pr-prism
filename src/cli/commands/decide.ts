import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { JevDecisionStore } from "../../decisions/decision-store.js";
import { createDecisionProvider } from "../../decisions/factory.js";
import { DEFAULT_JEV_MODEL } from "../../decisions/jev-provider.js";
import {
  estimateJevInferenceCostUsd,
  evaluateJevFirstItem,
  type JevFirstDecisionRecord,
} from "../../decisions/triage-v2.js";
import { createPipelineContext } from "../../pipeline.js";
import type { PRItem } from "../../types.js";
import { getDatabasePath, getDecisionsDatabasePath } from "../shared/paths.js";

export function registerDecideCommand(program: Command): void {
  const decide = program
    .command("decide")
    .description("Jev-First typed decision layer: evaluation, inspection, and decision status");

  // 1. evaluate
  decide
    .command("evaluate [number]")
    .description("Evaluate item(s) using Jev-First decomposed triage questions")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--all", "Evaluate all stored items without decisions")
    .option("--dry-run", "Show estimated items, token usage, and cost without invoking inference API")
    .option("--max-items <number>", "Maximum items to evaluate in this batch (safety ceiling)")
    .option("-m, --model <model>", "Jev model override", DEFAULT_JEV_MODEL)
    .option("--mock", "Use offline mock decision provider")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--json", "Output results as JSON")
    .action(async (numberArg: string | undefined, opts) => {
      const dbPath = getDatabasePath(opts.db);
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow("Database not initialized. Run 'prism init' or 'prism scan' first."));
        return;
      }

      const ctx = await createPipelineContext(opts.repo, { dbPath });
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      const jevStore = new JevDecisionStore(decisionsDbPath);

      try {
        const allItems = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (allItems.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        let targetItems: PRItem[] = [];
        if (numberArg !== undefined) {
          const num = parseInt(numberArg, 10);
          const found = allItems.find((i) => i.number === num);
          if (!found) {
            console.log(chalk.red(`Item #${num} not found in store.`));
            return;
          }
          targetItems = [found];
        } else if (opts.all) {
          const existingDecisions = jevStore.getAllDecisions(ctx.repoFull);
          const decidedNumbers = new Set(existingDecisions.map((d) => d.item.number));
          targetItems = allItems.filter((i) => !decidedNumbers.has(i.number));
        } else {
          console.log(
            chalk.yellow("Specify an item number or pass --all to evaluate pending items. Pass --dry-run to preview."),
          );
          return;
        }

        const maxItems = opts.maxItems ? parseInt(opts.maxItems, 10) : targetItems.length;
        const itemsToProcess = targetItems.slice(0, maxItems);

        // Dry-run planning
        if (opts.dryRun) {
          const estimatedTokensPerItem = 5500; // Average empirical prompt + completion
          const totalEstimatedTokens = itemsToProcess.length * estimatedTokensPerItem;
          const estimatedCost = estimateJevInferenceCostUsd(totalEstimatedTokens);

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  mode: "dry-run",
                  repo: ctx.repoFull,
                  model: opts.model,
                  targetItemCount: itemsToProcess.length,
                  estimatedTotalTokens: totalEstimatedTokens,
                  estimatedCostUsd: estimatedCost,
                  sampleItems: itemsToProcess
                    .slice(0, 5)
                    .map((i) => ({ number: i.number, type: i.type, title: i.title })),
                },
                null,
                2,
              ),
            );
          } else {
            console.log(chalk.bold("\n🔍 Jev Evaluation Dry-Run Planning:"));
            console.log(`  Repo: ${ctx.repoFull}`);
            console.log(`  Model: ${opts.model}`);
            console.log(`  Items to evaluate: ${itemsToProcess.length}`);
            console.log(`  Estimated token volume: ~${totalEstimatedTokens.toLocaleString()} tokens`);
            console.log(`  Estimated inference cost: ~$${estimatedCost.toFixed(4)} USD`);
            console.log(chalk.dim("\nZero API calls made. No database modifications made in dry-run mode."));
          }
          return;
        }

        // Provider initialization
        const provider = createDecisionProvider({
          enabled: true,
          provider: opts.mock ? "mock" : "jev",
          model: opts.model,
        });

        const spinner = ora(
          `Evaluating ${itemsToProcess.length} item(s) with Jev (${opts.mock ? "mock" : opts.model})...`,
        ).start();
        const evaluatedRecords: JevFirstDecisionRecord[] = [];

        for (const item of itemsToProcess) {
          try {
            const record = await evaluateJevFirstItem(item, provider, {
              model: opts.model,
            });
            jevStore.upsertDecision(record);
            evaluatedRecords.push(record);
          } catch (err: any) {
            spinner.fail(`Failed on #${item.number}: ${err.message}`);
            throw err;
          }
        }

        spinner.succeed(
          `Successfully evaluated and saved ${evaluatedRecords.length} decision(s) to ${decisionsDbPath}`,
        );

        if (opts.json) {
          console.log(JSON.stringify(evaluatedRecords, null, 2));
        } else if (evaluatedRecords.length === 1) {
          const rec = evaluatedRecords[0];
          const conf =
            rec.classification.categoryConfidence !== null
              ? `${(rec.classification.categoryConfidence * 100).toFixed(1)}%`
              : "N/A";
          console.log(chalk.bold(`\nDecision for #${rec.item.number} [${rec.item.type.toUpperCase()}]:`));
          console.log(`  Category: ${rec.classification.category} (${conf})`);
          console.log(`  Domain: ${rec.classification.technicalDomain}`);
          console.log(`  Priority: ${rec.derived.priorityTier}`);
          console.log(`  Complexity: ${rec.derived.complexityTier}`);
          console.log(`  Advisory Route: ${rec.routing.advisoryRoute}`);
          console.log(`  Escalate: ${rec.routing.escalateToDeepReview ? chalk.red("YES") : chalk.green("NO")}`);
        }
      } finally {
        jevStore.close();
        ctx.store.close();
      }
    });

  // 2. show <number>
  decide
    .command("show <number>")
    .description("Inspect stored Jev decision details for an item")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--type <pr|issue>", "Item type", "pr")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--json", "Output JSON to stdout")
    .action(async (numberArg: string, opts) => {
      const num = parseInt(numberArg, 10);
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      if (!existsSync(decisionsDbPath)) {
        console.log(chalk.yellow(`No decisions database found at ${decisionsDbPath}`));
        return;
      }

      const jevStore = new JevDecisionStore(decisionsDbPath);
      try {
        const repo = opts.repo || "odysseus-dev/odysseus";
        const decision = jevStore.getDecision(repo, opts.type as "pr" | "issue", num);
        if (!decision) {
          console.log(chalk.yellow(`No decision recorded for ${opts.type} #${num} in ${decisionsDbPath}`));
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(decision, null, 2));
        } else {
          const conf =
            decision.classification.categoryConfidence !== null
              ? `${(decision.classification.categoryConfidence * 100).toFixed(1)}%`
              : "N/A";
          console.log(chalk.bold(`\nJev Decision: #${decision.item.number} — ${decision.item.title}`));
          console.log(`  Model: ${decision.provenance.model}`);
          console.log(`  Evaluated: ${decision.provenance.evaluatedAt}`);
          console.log(`  Category: ${decision.classification.category} (${conf})`);
          console.log(`  Domain: ${decision.classification.technicalDomain}`);
          console.log(`  Priority Tier: ${decision.derived?.priorityTier || (decision as any).priority_tier}`);
          console.log(`  Complexity Tier: ${decision.derived?.complexityTier || (decision as any).complexity_tier}`);
          console.log(`  Advisory Route: ${decision.routing.advisoryRoute}`);
          console.log(`  Escalate: ${decision.routing.escalateToDeepReview ? chalk.red("YES") : "NO"}`);
          if (decision.routing.escalationReasons && decision.routing.escalationReasons.length > 0) {
            console.log(`  Escalation Reasons: ${decision.routing.escalationReasons.join("; ")}`);
          }
          if (decision.derived?.riskFlags && decision.derived.riskFlags.length > 0) {
            console.log(`  Risk Flags: ${decision.derived.riskFlags.join(", ")}`);
          }
          console.log(`  Estimated Cost: $${decision.provenance.estimatedCostUsd.toFixed(6)} USD`);
          console.log(`  Latency: ${decision.provenance.latencyMs}ms`);
        }
      } finally {
        jevStore.close();
      }
    });

  // 3. status
  decide
    .command("status")
    .description("Show summary metrics of evaluated Jev decisions in database")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--json", "Output JSON to stdout")
    .action(async (opts) => {
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      if (!existsSync(decisionsDbPath)) {
        console.log(chalk.yellow(`No decisions database found at ${decisionsDbPath}`));
        return;
      }

      const jevStore = new JevDecisionStore(decisionsDbPath);
      try {
        const repo = opts.repo || "odysseus-dev/odysseus";
        const decisions = jevStore.getAllDecisions(repo);

        const categoryCounts: Record<string, number> = {};
        const priorityCounts: Record<string, number> = {};
        const complexityCounts: Record<string, number> = {};
        let totalCost = 0;
        let totalLatency = 0;
        let escalatedCount = 0;

        for (const d of decisions) {
          categoryCounts[d.classification.category] = (categoryCounts[d.classification.category] || 0) + 1;
          const prio = d.derived?.priorityTier || (d as any).priority_tier || "unknown";
          priorityCounts[prio] = (priorityCounts[prio] || 0) + 1;
          const comp = d.derived?.complexityTier || (d as any).complexity_tier || "unknown";
          complexityCounts[comp] = (complexityCounts[comp] || 0) + 1;
          totalCost += d.provenance.estimatedCostUsd || 0;
          totalLatency += d.provenance.latencyMs || 0;
          if (d.routing.escalateToDeepReview) escalatedCount++;
        }

        const metrics = {
          repo,
          decisionsDbPath,
          totalDecisions: decisions.length,
          escalatedCount,
          totalCostUsd: totalCost,
          avgLatencyMs: decisions.length > 0 ? Math.round(totalLatency / decisions.length) : 0,
          categories: categoryCounts,
          priorities: priorityCounts,
          complexities: complexityCounts,
        };

        if (opts.json) {
          console.log(JSON.stringify(metrics, null, 2));
        } else {
          console.log(chalk.bold(`\nJev Decisions Status (${decisionsDbPath}):`));
          console.log(`  Repository: ${repo}`);
          console.log(`  Total stored decisions: ${decisions.length}`);
          console.log(`  Escalated to human maintainer: ${escalatedCount}`);
          console.log(`  Total estimated inference cost: $${totalCost.toFixed(4)} USD`);
          console.log(`  Average latency: ${metrics.avgLatencyMs}ms`);
          console.log(chalk.bold("\nCategory Breakdown:"));
          for (const [k, v] of Object.entries(categoryCounts)) {
            console.log(`  - ${k}: ${v}`);
          }
          console.log(chalk.bold("\nPriority Tier Breakdown:"));
          for (const [k, v] of Object.entries(priorityCounts)) {
            console.log(`  - ${k}: ${v}`);
          }
          console.log(chalk.bold("\nComplexity Tier Breakdown:"));
          for (const [k, v] of Object.entries(complexityCounts)) {
            console.log(`  - ${k}: ${v}`);
          }
        }
      } finally {
        jevStore.close();
      }
    });
}
