import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { findDuplicateClusters } from "../../cluster.js";
import { createPipelineContext } from "../../pipeline.js";
import { classifyClusterRelation } from "../../relations.js";
import { sanitizeTitle } from "../../sanitize.js";
import { buildScorerContext, rankPRs } from "../../scorer.js";
import type { PRItem } from "../../types.js";
import { checkVisionAlignment } from "../../vision.js";
import { generateMarkdownReport } from "../formatting/report.js";
import { getDataDir } from "../shared/paths.js";

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Generate a markdown triage report")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-o, --output <path>", "Output file path", "prism-report.md")
    .option("--top <number>", "Top N ranked PRs to include", "20")
    .option("--clusters <number>", "Top N duplicate clusters to include", "25")
    .option("--verbose", "Expand every cluster with per-item similarity breakdown (default for file output)")
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
        includeBotAuthors: config.cluster.include_bot_authors,
        botAuthors: new Set(config.cluster.bot_authors),
      });

      spinner.text = "Building scorer context...";
      const context = await buildScorerContext(items, github, store, repoFull);
      const ranked = rankPRs(items, config, context);

      let visionResults: { aligned: number; drifting: number; offVision: number } | null = null;

      let visionDocPath = config.vision_doc;
      if (!visionDocPath || !existsSync(visionDocPath)) {
        for (const candidate of ["VISION.md", "README.md"]) {
          const content = await github.fetchFileContent(candidate);
          if (content) {
            const dataDir = getDataDir();
            const localPath = resolve(dataDir, candidate);
            mkdirSync(dataDir, { recursive: true });
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
            clusters: clusters.slice(0, clusterN).map((c) => {
              const rel = classifyClusterRelation(c.items);
              return {
                id: c.id,
                size: c.items.length,
                avgSimilarity: c.avgSimilarity,
                minSimilarity: c.minSimilarity,
                bestPick: c.bestPick.number,
                theme: sanitizeTitle(c.theme),
                ...(rel.relation !== undefined ? { relation: rel.relation, closingEdges: rel.closingEdges } : {}),
              };
            }),
            ranked: ranked.slice(0, topN).map((pr) => ({
              number: pr.number,
              score: pr.score,
              author: pr.author,
              title: sanitizeTitle(pr.title),
            })),
            vision: visionResults,
          }),
        );
        spinner.succeed("Report generated (JSON)");
        store.close();
        return;
      }

      // verbose defaults to true for file output
      const verbose = opts.verbose !== undefined ? opts.verbose : true;

      const report = generateMarkdownReport({
        repoFull,
        date: now,
        stats,
        clusters,
        ranked,
        visionResults,
        topN,
        clusterN,
        verbose,
        store,
      });

      writeFileSync(opts.output, report);
      spinner.succeed(`Report saved to ${opts.output}`);

      console.log(chalk.dim(`  ${stats.totalItems} items, ${clusters.length} duplicate clusters, top ${topN} ranked`));
      store.close();
    });
}
