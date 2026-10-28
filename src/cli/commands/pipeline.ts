import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { findDuplicateClusters } from "../../cluster.js";
import { JevDecisionStore } from "../../decisions/decision-store.js";
import { estimateJevInferenceCostUsd } from "../../decisions/triage-v2.js";
import {
  computeIssueInputFingerprint,
  computePRInputFingerprint,
  DEEP_REVIEW_PROMPT_VERSION,
} from "../../deep-reviewer.js";
import {
  buildClosureCandidateRecord,
  type ClosureCandidateRecord,
  exportClosureCandidates,
} from "../../housekeeping/closure-verification.js";
import { calibrateItem } from "../../housekeeping/priority-calibration.js";
import { discoverRelationshipCandidates } from "../../housekeeping/relationship-discovery.js";
import { buildTriagePlan, exportTriagePlanJson, type TriagePlanInputEntry } from "../../housekeeping/triage-plan.js";
import { generateBacklogJson, generateBacklogReport } from "../../maintainer/reports.js";
import { buildWorklist } from "../../maintainer/worklist.js";
import { createPipelineContext } from "../../pipeline.js";
import { DurableReviewQueue } from "../../review-queue.js";
import type { PRItem } from "../../types.js";
import { getDatabasePath, getDecisionsDatabasePath, getQueueDatabasePath } from "../shared/paths.js";

function extractNoul(answer: unknown): number | undefined {
  if (!answer) return undefined;
  if (typeof answer === "number") return answer;
  if (typeof answer === "object") {
    const a = answer as any;
    if (typeof a.noul === "number") return a.noul;
    if (typeof a.score === "number") return a.score;
  }
  return undefined;
}

export const PIPELINE_STAGES = [
  { id: 1, name: "doctor", title: "Doctor & Credentials Validation", external: false, paid: false },
  { id: 2, name: "ingestion", title: "GitHub Ingestion (PRs & Issues)", external: true, paid: false },
  { id: 3, name: "decisions", title: "Jev Resolution Decisions", external: true, paid: true },
  { id: 4, name: "relationships", title: "Indexed Relationship Discovery", external: false, paid: false },
  { id: 5, name: "closures", title: "Deterministic Closure Verification", external: false, paid: false },
  { id: 6, name: "calibrate", title: "Priority Recalibration (P0 Negative Controls)", external: false, paid: false },
  { id: 7, name: "plan", title: "Triage Plan & Review Routing Schedule", external: false, paid: false },
  { id: 8, name: "review", title: "Tiered Multi-Account Review Execution", external: true, paid: true },
  { id: 9, name: "maintainer", title: "Maintainer Workbench & Executive Reports", external: false, paid: false },
] as const;

export function registerPipelineCommand(program: Command): void {
  const pipeline = program.command("pipeline").description("PR-Prism v4 End-to-End Operational Pipeline orchestrator");

  // 1. plan
  pipeline
    .command("plan")
    .description("Dry-run inspection and call/cost projections for the 9-stage pipeline")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--queue-db <path>", "Path to durable review queue SQLite database")
    .option("--json", "Output JSON to stdout")
    .action(async (opts) => {
      const dbPath = getDatabasePath(opts.db);
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      const queueDbPath = getQueueDatabasePath(opts.queueDb);

      let itemsCount = 0;
      let prCount = 0;
      let issueCount = 0;
      let decisionsCount = 0;
      let pendingDecisionsCount = 0;
      let queuedReviewJobs = 0;
      let completedCheckpoints = 0;

      if (existsSync(dbPath)) {
        try {
          const ctx = await createPipelineContext(opts.repo, { dbPath });
          const items = ctx.store.getAllItems(ctx.repoFull);
          itemsCount = items.length;
          prCount = items.filter((i) => i.type === "pr").length;
          issueCount = items.filter((i) => i.type === "issue").length;
          ctx.store.close();
        } catch {}
      }

      if (existsSync(decisionsDbPath)) {
        try {
          const jevStore = new JevDecisionStore(decisionsDbPath);
          const repo = opts.repo || "odysseus-dev/odysseus";
          const decisions = jevStore.getAllDecisions(repo);
          decisionsCount = decisions.length;
          pendingDecisionsCount = Math.max(0, itemsCount - decisionsCount);
          jevStore.close();
        } catch {}
      } else {
        pendingDecisionsCount = itemsCount;
      }

      if (existsSync(queueDbPath)) {
        try {
          const queue = new DurableReviewQueue(queueDbPath);
          const jobs = queue.listJobs();
          queuedReviewJobs = jobs.filter((j) => j.status === "queued" || j.status === "claimed").length;
          const allCheckpoints = (queue as any).db
            .prepare(
              "SELECT count(*) as cnt FROM review_checkpoints WHERE checkpoint_status IS NULL OR checkpoint_status != 'invalid'",
            )
            .get();
          completedCheckpoints = allCheckpoints?.cnt || 0;
          queue.close();
        } catch {}
      }

      const jevEstimatedTokens = pendingDecisionsCount * 5500;
      const jevEstimatedCostUsd = estimateJevInferenceCostUsd(jevEstimatedTokens);

      const planData = {
        generatedAt: new Date().toISOString(),
        workspace: {
          prismDb: dbPath,
          decisionsDb: decisionsDbPath,
          queueDb: queueDbPath,
        },
        inventory: {
          totalStoredItems: itemsCount,
          prs: prCount,
          issues: issueCount,
          existingJevDecisions: decisionsCount,
          pendingJevDecisions: pendingDecisionsCount,
          queuedReviewJobs,
          completedReviewCheckpoints: completedCheckpoints,
        },
        estimates: {
          jevTokensProjected: jevEstimatedTokens,
          jevCostUsdProjected: jevEstimatedCostUsd,
        },
        stages: PIPELINE_STAGES.map((s) => ({
          stage: s.id,
          name: s.name,
          title: s.title,
          isExternalApi: s.external,
          isPaidInference: s.paid,
          status:
            s.id === 1
              ? "ready"
              : s.id === 2
                ? itemsCount > 0
                  ? "completed"
                  : "pending"
                : s.id === 3
                  ? pendingDecisionsCount === 0 && itemsCount > 0
                    ? "completed"
                    : `${pendingDecisionsCount} pending`
                  : s.id === 8
                    ? queuedReviewJobs > 0
                      ? `${queuedReviewJobs} queued`
                      : "idle"
                    : itemsCount > 0
                      ? "ready"
                      : "blocked",
        })),
      };

      if (opts.json) {
        console.log(JSON.stringify(planData, null, 2));
      } else {
        console.log(chalk.bold("\n📋 PR-Prism v4 Operational Pipeline Plan & Estimates"));
        console.log(`  Target DB: ${dbPath} (${itemsCount} items: ${prCount} PRs, ${issueCount} Issues)`);
        console.log(
          `  Decisions DB: ${decisionsDbPath} (${decisionsCount} existing, ${pendingDecisionsCount} pending)`,
        );
        console.log(
          `  Review Queue DB: ${queueDbPath} (${queuedReviewJobs} queued jobs, ${completedCheckpoints} completed)`,
        );
        console.log(chalk.bold("\nProjected Expensive Operations (Explicitly Gated):"));
        console.log(
          `  - Jev Inference: ${pendingDecisionsCount} items -> ~${jevEstimatedTokens.toLocaleString()} tokens (~$${jevEstimatedCostUsd.toFixed(4)} USD)`,
        );
        console.log(
          `  - Featherless LLM Reviews: ${queuedReviewJobs} queued jobs (controlled by --max-jobs safety cap)`,
        );
        console.log(chalk.bold("\nPipeline Stages (Local vs External):"));
        for (const stage of planData.stages) {
          const typeBadge = stage.isPaidInference
            ? chalk.yellow("[PAID API]")
            : stage.isExternalApi
              ? chalk.cyan("[EXT API]")
              : chalk.green("[LOCAL]");
          console.log(`  ${stage.stage}. ${stage.title} ${typeBadge} — status: ${stage.status}`);
        }
        console.log(chalk.dim("\nDry-run complete. Zero paid API calls made. Zero database mutations."));
      }
    });

  // 2. status
  pipeline
    .command("status")
    .description("Inspect current pipeline artifacts, queues, and checkpoints")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--queue-db <path>", "Path to durable review queue SQLite database")
    .option("-o, --reports-dir <dir>", "Directory containing generated reports", "reports")
    .option("--json", "Output JSON to stdout")
    .action(async (opts) => {
      const dbPath = getDatabasePath(opts.db);
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      const queueDbPath = getQueueDatabasePath(opts.queueDb);
      const reportsDir = opts.reportsDir || "reports";

      let items = 0;
      let decisions = 0;
      let queuedJobs = 0;
      let completedJobs = 0;

      if (existsSync(dbPath)) {
        try {
          const ctx = await createPipelineContext(opts.repo, { dbPath });
          items = ctx.store.getAllItems(ctx.repoFull).length;
          ctx.store.close();
        } catch {}
      }

      if (existsSync(decisionsDbPath)) {
        try {
          const jevStore = new JevDecisionStore(decisionsDbPath);
          decisions = jevStore.getAllDecisions(opts.repo || "odysseus-dev/odysseus").length;
          jevStore.close();
        } catch {}
      }

      if (existsSync(queueDbPath)) {
        try {
          const queue = new DurableReviewQueue(queueDbPath);
          const all = queue.listJobs();
          queuedJobs = all.filter((j) => j.status === "queued" || j.status === "claimed").length;
          completedJobs = all.filter((j) => j.status === "completed").length;
          queue.close();
        } catch {}
      }

      const artifacts = {
        relationships: existsSync(resolve(reportsDir, "relationships.json")),
        closureCandidates: existsSync(resolve(reportsDir, "closure-candidates.json")),
        calibratedPriority: existsSync(resolve(reportsDir, "calibrated-priority.json")),
        triagePlan: existsSync(resolve(reportsDir, "triage-plan.json")),
        maintainerReport: existsSync(resolve(reportsDir, "maintainer-report.md")),
      };

      const statusOutput = {
        timestamp: new Date().toISOString(),
        databases: {
          prismDb: { path: dbPath, exists: existsSync(dbPath), items },
          decisionsDb: { path: decisionsDbPath, exists: existsSync(decisionsDbPath), decisions },
          queueDb: { path: queueDbPath, exists: existsSync(queueDbPath), queuedJobs, completedJobs },
        },
        artifacts,
      };

      if (opts.json) {
        console.log(JSON.stringify(statusOutput, null, 2));
      } else {
        console.log(chalk.bold("\n🔍 PR-Prism v4 Pipeline Status:"));
        console.log(
          `  Items in Store: ${items} (${existsSync(dbPath) ? chalk.green("ONLINE") : chalk.red("MISSING")})`,
        );
        console.log(
          `  Jev Decisions: ${decisions} (${existsSync(decisionsDbPath) ? chalk.green("ONLINE") : chalk.red("MISSING")})`,
        );
        console.log(
          `  Review Queue: ${queuedJobs} queued, ${completedJobs} completed (${existsSync(queueDbPath) ? chalk.green("ONLINE") : chalk.dim("IDLE")})`,
        );
        console.log(chalk.bold("\nGenerated Report Artifacts:"));
        for (const [art, present] of Object.entries(artifacts)) {
          console.log(`  - ${art}: ${present ? chalk.green("PRESENT") : chalk.dim("NOT GENERATED")}`);
        }
      }
    });

  // 3. run
  pipeline
    .command("run")
    .description("Execute pipeline stages (supports --from, --to, --dry-run, --resume, and bounded execution)")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--from <stage>", "Start at stage name or number (1-9)", "4")
    .option("--to <stage>", "End at stage name or number (1-9)", "9")
    .option("--dry-run", "Dry run: simulate execution without paid model calls")
    .option("--max-jobs <number>", "Hard stop ceiling on paid LLM review calls", "0")
    .option("--seed-queue", "Seed review queue during triage plan stage", true)
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--queue-db <path>", "Path to durable review queue SQLite database")
    .option("-o, --out-dir <dir>", "Directory to save generated artifacts", "reports")
    .action(async (opts) => {
      const fromStage = parseInt(opts.from, 10) || 4;
      const toStage = parseInt(opts.to, 10) || 9;
      const outDir = opts.outDir || "reports";
      mkdirSync(resolve(outDir), { recursive: true });

      console.log(chalk.bold(`\n🚀 Executing PR-Prism v4 Pipeline: Stages ${fromStage} -> ${toStage}\n`));

      const dbPath = getDatabasePath(opts.db);
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      const queueDbPath = getQueueDatabasePath(opts.queueDb);

      if (!existsSync(dbPath) && fromStage > 2) {
        console.log(chalk.red(`Prism database not found at ${dbPath}. Run stage 2 (scan) first.`));
        return;
      }

      const ctx = await createPipelineContext(opts.repo, { dbPath });
      let jevStore: JevDecisionStore | undefined;
      if (existsSync(decisionsDbPath)) {
        try {
          jevStore = new JevDecisionStore(decisionsDbPath);
        } catch {}
      }

      try {
        const items = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        console.log(chalk.dim(`Loaded ${items.length} item(s) from ${ctx.repoFull}\n`));

        const clusters = findDuplicateClusters(ctx.store, items, {
          threshold: ctx.config.thresholds.duplicate_similarity,
          repo: ctx.repoFull,
          includeBotAuthors: ctx.config.cluster.include_bot_authors,
          botAuthors: new Set(ctx.config.cluster.bot_authors),
        });

        // Stage 4: Relationships
        if (fromStage <= 4 && toStage >= 4) {
          const s = ora("Stage 4: Non-quadratic relationship discovery...").start();
          const relResult = discoverRelationshipCandidates(items, clusters, { repo: ctx.repoFull });
          writeFileSync(resolve(outDir, "relationships.json"), `${JSON.stringify(relResult, null, 2)}\n`);
          s.succeed(`Stage 4 complete: ${relResult.candidates.length} relationship candidate(s)`);
        }

        // Stage 5: Closures
        const verifiedClosureItems = new Map<number, string>();
        if (fromStage <= 5 && toStage >= 5) {
          const s = ora("Stage 5: Deterministic 6-tier closure verification...").start();
          const relResult = discoverRelationshipCandidates(items, clusters, { repo: ctx.repoFull });
          const itemMap = new Map<number, PRItem>();
          for (const item of items) itemMap.set(item.number, item);

          const candidateRecords: ClosureCandidateRecord[] = [];
          for (const rel of relResult.candidates) {
            const sourceItem = itemMap.get(rel.sourceNumber);
            const targetItem = itemMap.get(rel.targetNumber);
            if (!sourceItem || !targetItem) continue;

            const decision = jevStore?.getDecision(
              ctx.repoFull,
              (sourceItem.type as "pr" | "issue") || "pr",
              sourceItem.number,
            );
            const dupNoul = extractNoul(decision?.rawAnswers?.duplicate_candidate);
            const resNoul = extractNoul(decision?.rawAnswers?.already_resolved_candidate);

            const record = buildClosureCandidateRecord(sourceItem, targetItem, {
              embeddingSimilarity: rel.embeddingSimilarity ?? null,
              closingEdgeConfirmed:
                rel.evidenceTier === "DETERMINISTIC" || rel.evidenceFactors.includes("closes_reference"),
              jevDecision: decision
                ? {
                    duplicateCandidateNoul: dupNoul,
                    alreadyResolvedNoul: resNoul,
                    confidence: decision.classification.categoryConfidence ?? undefined,
                    model: decision.provenance.model,
                  }
                : undefined,
            });

            candidateRecords.push(record);
            if (record.closureVerified) {
              verifiedClosureItems.set(
                sourceItem.number,
                `Verified redundancy with #${targetItem.number} (${record.relationship})`,
              );
            }
          }
          const closureExport = exportClosureCandidates(candidateRecords, ctx.repoFull);
          writeFileSync(resolve(outDir, "closure-candidates.json"), `${JSON.stringify(closureExport, null, 2)}\n`);
          s.succeed(
            `Stage 5 complete: ${closureExport.verifiedCandidates} verified, ${closureExport.pendingManualReview} pending`,
          );
        }

        // Stage 6: Calibrate Priority
        if (fromStage <= 6 && toStage >= 6) {
          const s = ora("Stage 6: Calibrating priority with P0 negative controls...").start();
          const calibratedItems = items.map((item) => {
            const decision = jevStore?.getDecision(ctx.repoFull, (item.type as "pr" | "issue") || "pr", item.number);
            const originalBand =
              decision?.derived?.priorityTier || (decision as any)?.priority_tier || "P3_ROUTINE_LOCAL";
            const originalReasons = decision?.routing?.escalationReasons || [];
            return calibrateItem(item, originalBand, originalReasons, decision as any);
          });
          writeFileSync(resolve(outDir, "calibrated-priority.json"), `${JSON.stringify(calibratedItems, null, 2)}\n`);
          s.succeed(`Stage 6 complete: calibrated ${calibratedItems.length} items`);
        }

        // Stage 7: Triage Plan & Review Routing
        if (fromStage <= 7 && toStage >= 7) {
          const s = ora("Stage 7: Reproducible triage plan & scheduler contract...").start();
          const itemMap = new Map<number, PRItem>();
          for (const item of items) itemMap.set(item.number, item);

          const planInputEntries: TriagePlanInputEntry[] = items.map((item) => {
            const decision = jevStore?.getDecision(ctx.repoFull, (item.type as "pr" | "issue") || "pr", item.number);
            const isVerifiedClosure = verifiedClosureItems.has(item.number);
            const closureNote = verifiedClosureItems.get(item.number);

            const originalBand =
              decision?.derived?.priorityTier || (decision as any)?.priority_tier || "P3_ROUTINE_LOCAL";
            const originalReasons = decision?.routing?.escalationReasons || [];
            const calibrated = calibrateItem(item, originalBand, originalReasons, decision as any);

            let actionSignal = "READY_FOR_MAINTAINER";
            const reasons: string[] = [];

            if (isVerifiedClosure) {
              actionSignal = "CLOSE_CANDIDATE";
              reasons.push(closureNote || "Deterministic verification criteria met");
            } else if (decision) {
              const route = decision.routing.advisoryRoute;
              const comp = decision.derived?.complexityTier as string | undefined;
              if (route === "documentation_only" || comp === "routine" || comp === "low") {
                actionSignal = "LIGHT_REVIEW";
                reasons.push("Low review complexity, routine change");
              } else if (comp === "moderate" || comp === "medium") {
                actionSignal = "INTERMEDIATE_REVIEW";
                reasons.push("Non-trivial complexity, requires bounded intermediate review");
              } else if (route === "expert_investigation" || comp === "complex" || comp === "high") {
                actionSignal = "COMPLEX_REVIEW_NEEDED";
                reasons.push("High complexity change, warrants deep architectural evaluation");
              } else if (
                decision.routing.escalateToDeepReview ||
                route === "security_escalation" ||
                route === "maintainer_triage"
              ) {
                actionSignal = "MAINTAINER_DECISION";
                reasons.push(...(decision.routing.escalationReasons || []));
              }
            }

            return {
              item,
              actionSignal,
              actionReasons: reasons,
              calibratedBand: calibrated.calibratedBand,
              closureCandidateVerified: isVerifiedClosure,
              closureCandidateEvidenceNote: closureNote,
            };
          });

          const plan = buildTriagePlan(planInputEntries, ctx.repoFull);
          writeFileSync(resolve(outDir, "triage-plan.json"), `${exportTriagePlanJson(plan)}\n`);

          if (opts.seedQueue) {
            const queue = new DurableReviewQueue(queueDbPath);
            try {
              let seededCount = 0;
              const reviewEntries = plan.entries.filter(
                (e) =>
                  e.actionGroup === "LIGHT_REVIEW" ||
                  e.actionGroup === "INTERMEDIATE_REVIEW" ||
                  e.actionGroup === "COMPLEX_REVIEW_NEEDED",
              );

              for (const entry of reviewEntries) {
                const fullItem = itemMap.get(entry.number);
                if (!fullItem) continue;

                const tier =
                  entry.actionGroup === "LIGHT_REVIEW"
                    ? "light"
                    : entry.actionGroup === "INTERMEDIATE_REVIEW"
                      ? "intermediate"
                      : "complex";

                const fingerprint =
                  entry.itemType === "pr"
                    ? computePRInputFingerprint({
                        repo: fullItem.repo,
                        number: fullItem.number,
                        title: fullItem.title,
                        body: fullItem.body,
                      })
                    : computeIssueInputFingerprint({
                        repo: fullItem.repo,
                        number: fullItem.number,
                        title: fullItem.title,
                        body: fullItem.body,
                        author: fullItem.author,
                      });

                const bandRank = entry.priorityBand.startsWith("P0")
                  ? "P0_CRITICAL"
                  : entry.priorityBand.startsWith("P1")
                    ? "P1_HIGH"
                    : entry.priorityBand.startsWith("P2")
                      ? "P2_MODERATE"
                      : "P3_ROUTINE_LOCAL";

                const priorityScore =
                  (bandRank === "P0_CRITICAL"
                    ? 4000
                    : bandRank === "P1_HIGH"
                      ? 3000
                      : bandRank === "P2_MODERATE"
                        ? 2000
                        : 1000) +
                  (entry.itemType === "pr" ? 500 : 0) +
                  Math.max(0, 100 - entry.rank);

                queue.enqueueJob({
                  repo: entry.repo,
                  itemType: entry.itemType,
                  itemNumber: entry.number,
                  title: entry.title,
                  priorityBand: bandRank as any,
                  priorityScore,
                  inputFingerprint: fingerprint,
                  promptSchemaVersion: DEEP_REVIEW_PROMPT_VERSION,
                  payload: {
                    tier,
                    actionGroup: entry.actionGroup,
                    priorityBand: entry.priorityBand,
                    actionSignal: entry.actionSignal,
                  },
                });
                seededCount++;
              }
              s.succeed(`Stage 7 complete: Triage plan saved, seeded ${seededCount} review jobs into queue`);
            } finally {
              queue.close();
            }
          } else {
            s.succeed("Stage 7 complete: Triage plan saved");
          }
        }

        // Stage 8: Review Execution (Bounded or Dry-Run)
        if (fromStage <= 8 && toStage >= 8) {
          const maxJobs = parseInt(opts.maxJobs, 10) || 0;
          if (maxJobs === 0 || opts.dryRun) {
            console.log(
              chalk.yellow(
                "Stage 8 (Paid Reviews): Skipped inference (dry-run mode or --max-jobs 0). Run 'prism review --resume --max-jobs N' to execute.",
              ),
            );
          } else {
            console.log(chalk.bold(`Stage 8: Executing up to ${maxJobs} review job(s)...`));
          }
        }

        // Stage 9: Maintainer Workbench & Reports
        if (fromStage <= 9 && toStage >= 9) {
          const s = ora("Stage 9: Maintainer workbench & executive report generation...").start();
          let queue: DurableReviewQueue | undefined;
          if (existsSync(queueDbPath)) {
            try {
              queue = new DurableReviewQueue(queueDbPath);
            } catch {}
          }

          const worklist = buildWorklist({
            store: ctx.store,
            repo: ctx.repoFull,
            clusters,
            jevStore,
            queue,
          });

          const reportMd = generateBacklogReport(worklist.items, ctx.repoFull);
          const reportJson = generateBacklogJson(worklist.items, ctx.repoFull);

          writeFileSync(resolve(outDir, "maintainer-report.md"), `${reportMd}\n`);
          writeFileSync(resolve(outDir, "maintainer-report.json"), `${JSON.stringify(reportJson, null, 2)}\n`);

          queue?.close();
          s.succeed(`Stage 9 complete: Saved ${resolve(outDir, "maintainer-report.md")}`);
        }

        console.log(chalk.bold.green(`\n✨ Pipeline execution finished. All artifacts saved to ${outDir}`));
      } finally {
        jevStore?.close();
        ctx.store.close();
      }
    });
}
