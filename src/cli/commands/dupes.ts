import { writeFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { findDuplicateClusters } from "../../cluster.js";
import { buildHousekeepingManifest } from "../../housekeeping.js";
import { findConfirmedDuplicates } from "../../identity.js";
import { createPipelineContext, resolveRepos, runDupes, runDupesMulti } from "../../pipeline.js";
import { classifyClusterRelation } from "../../relations.js";
import { sanitizeTitle } from "../../sanitize.js";
import { buildStarmapPayload } from "../../starmap.js";
import type { PRItem } from "../../types.js";
import { validateJsonOutputMutex } from "../shared/validation.js";

export function registerDupesCommand(program: Command): void {
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
    .option(
      "--starmap <path>",
      "Also write a stable star-map JSON contract (clusters + confidence + join keys) to <path>",
    )
    .option(
      "--housekeeping <path>",
      "Also write an editable housekeeping to-do (tracker + close checklist, no auto-writes) to <path>",
    )
    .action(async (opts) => {
      validateJsonOutputMutex(opts);
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
            includeBotAuthors: ctx.config.cluster.include_bot_authors,
            botAuthors: new Set(ctx.config.cluster.bot_authors),
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
          console.log(chalk.bold(`\nCluster #${cluster.id}: "${sanitizeTitle(cluster.theme)}"`));
          const clusterRel = classifyClusterRelation(cluster.items);
          const relSuffix = clusterRel.relation !== undefined ? ` | Relation: ${clusterRel.relation}` : "";
          console.log(
            `Items: ${cluster.items.length} | Avg similarity: ${(cluster.avgSimilarity * 100).toFixed(1)}%${relSuffix}\n`,
          );
          for (const item of cluster.items) {
            const isBest = item.number === cluster.bestPick.number;
            const prefix = isBest ? chalk.green("★") : " ";
            const repoTag = isMultiRepo ? chalk.dim(`[${item.repo}] `) : "";
            console.log(`${prefix} ${repoTag}#${item.number} ${sanitizeTitle(item.title)}`);
            console.log(
              `  Author: ${item.author} | Updated: ${item.updatedAt.slice(0, 10)} | Score: ${item.score.toFixed(2)}`,
            );
          }
        } else {
          const clusters = isMultiRepo
            ? await runDupesMulti(ctx, repos, {
                threshold: opts.threshold !== undefined ? parseFloat(opts.threshold) : undefined,
                applyLabels: opts.applyLabels,
                dryRun: opts.dryRun,
                json: opts.json,
                output: opts.output,
              })
            : await runDupes(ctx, {
                threshold: opts.threshold !== undefined ? parseFloat(opts.threshold) : undefined,
                applyLabels: opts.applyLabels,
                dryRun: opts.dryRun,
                json: opts.json,
                output: opts.output,
              });

          if (opts.starmap) {
            const threshold =
              opts.threshold !== undefined ? parseFloat(opts.threshold) : ctx.config.thresholds.duplicate_similarity;
            // Deterministic confirmed-duplicate tier (head-oid / patch-id), computed over
            // ALL items - a confirmed pair need not have fuzzy-clustered - and surfaced first.
            const allItems = (isMultiRepo
              ? ctx.store.getAllItemsMulti(repos)
              : ctx.store.getAllItems(ctx.repoFull)) as unknown as PRItem[];
            const confirmed = findConfirmedDuplicates(allItems, {
              store: ctx.store,
              includeBotAuthors: ctx.config.cluster.include_bot_authors,
              botAuthors: new Set(ctx.config.cluster.bot_authors),
            });
            const payload = buildStarmapPayload(
              clusters,
              {
                repo: isMultiRepo ? repos.join(", ") : ctx.repoFull,
                threshold,
                generatedAt: new Date().toISOString(),
                embeddingModel: ctx.store.getMeta("embedding_model") ?? "unknown",
                embeddingProvider: ctx.store.getMeta("embedding_provider") ?? "unknown",
                embeddingDimensions: Number(ctx.store.getMeta("embedding_dimensions") ?? 0),
                embeddingConfigHash: ctx.store.getMeta("embedding_config_hash") ?? "unknown",
              },
              { confirmed },
            );
            writeFileSync(opts.starmap, `${JSON.stringify(payload, null, 2)}\n`);
            console.log(chalk.green(`★ star-map JSON written to ${opts.starmap} (${payload.clusterCount} clusters)`));
          }

          if (opts.housekeeping) {
            const allItems = (isMultiRepo
              ? ctx.store.getAllItemsMulti(repos)
              : ctx.store.getAllItems(ctx.repoFull)) as unknown as PRItem[];
            const confirmed = findConfirmedDuplicates(allItems, {
              store: ctx.store,
              includeBotAuthors: ctx.config.cluster.include_bot_authors,
              botAuthors: new Set(ctx.config.cluster.bot_authors),
            });
            const manifest = buildHousekeepingManifest(clusters, {
              repo: isMultiRepo ? repos.join(", ") : ctx.repoFull,
              confirmed,
            });
            writeFileSync(opts.housekeeping, manifest);
            console.log(chalk.green(`✓ housekeeping manifest written to ${opts.housekeeping}`));
          }
        }
      } finally {
        ctx.store.close();
      }
    });
}
