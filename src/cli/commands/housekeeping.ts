import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { findDuplicateClusters } from "../../cluster.js";
import { JevDecisionStore } from "../../decisions/decision-store.js";
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
import { createPipelineContext } from "../../pipeline.js";
import { DurableReviewQueue } from "../../review-queue.js";
import type { PRItem } from "../../types.js";
import { getDatabasePath, getDecisionsDatabasePath, getQueueDatabasePath } from "../shared/paths.js";

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

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

export function registerHousekeepingCommand(program: Command): void {
  const housekeeping = program
    .command("housekeeping")
    .description(
      "Deterministic housekeeping intelligence: relationships, closure verification, priority calibration, and triage planning",
    );

  // 1. relationships
  housekeeping
    .command("relationships")
    .alias("discover")
    .description(
      "Discover non-quadratic relationship candidates (identity, closes, cross-ref, duplicate, supersession)",
    )
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-o, --out <path>", "Output file path (e.g. reports/relationships.json)")
    .option("-t, --threshold <number>", "Embedding similarity threshold (default: 0.72)", "0.72")
    .option("--strong-threshold <number>", "Strong similarity threshold (default: 0.85)", "0.85")
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--json", "Output JSON to stdout")
    .action(async (opts) => {
      const dbPath = getDatabasePath(opts.db);
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow("Database not initialized. Run 'prism init' or 'prism scan' first."));
        return;
      }

      const ctx = await createPipelineContext(opts.repo, { dbPath });
      try {
        const items = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (items.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const spinner = ora("Discovering candidate relationships...").start();
        const threshold = parseFloat(opts.threshold) || 0.72;
        const strongThreshold = parseFloat(opts.strongThreshold) || 0.85;

        const clusters = findDuplicateClusters(ctx.store, items, {
          threshold: ctx.config.thresholds.duplicate_similarity,
          repo: ctx.repoFull,
          includeBotAuthors: ctx.config.cluster.include_bot_authors,
          botAuthors: new Set(ctx.config.cluster.bot_authors),
        });

        const result = discoverRelationshipCandidates(items, clusters, {
          repo: ctx.repoFull,
          embeddingSimThreshold: threshold,
          strongEvidenceThreshold: strongThreshold,
        });

        spinner.succeed(
          `Discovered ${result.candidates.length} candidate relationship(s) across ${items.length} items`,
        );

        if (opts.out) {
          ensureParentDir(opts.out);
          writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);
          console.log(chalk.green(`✓ Relationships written to ${opts.out}`));
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (!opts.out) {
          const byKind: Record<string, number> = {};
          const byTier: Record<string, number> = {};
          for (const c of result.candidates) {
            byKind[c.kind] = (byKind[c.kind] || 0) + 1;
            byTier[c.evidenceTier] = (byTier[c.evidenceTier] || 0) + 1;
          }
          console.log(chalk.bold("\nDiscovered Relationship Breakdown:"));
          for (const [kind, count] of Object.entries(byKind)) {
            console.log(`  - ${kind}: ${count}`);
          }
          console.log(chalk.bold("\nEvidence Tiers:"));
          for (const [tier, count] of Object.entries(byTier)) {
            console.log(`  - ${tier}: ${count}`);
          }
        }
      } finally {
        ctx.store.close();
      }
    });

  // 2. closures
  housekeeping
    .command("closures")
    .alias("verify")
    .description("Evidence-based 6-tier closure candidate verification (never auto-closes)")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-o, --out <path>", "Output file path (e.g. reports/closure-candidates.json)")
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--json", "Output JSON to stdout")
    .action(async (opts) => {
      const dbPath = getDatabasePath(opts.db);
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow("Database not initialized. Run 'prism init' or 'prism scan' first."));
        return;
      }

      const ctx = await createPipelineContext(opts.repo, { dbPath });
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      let jevStore: JevDecisionStore | undefined;
      if (existsSync(decisionsDbPath)) {
        try {
          jevStore = new JevDecisionStore(decisionsDbPath);
        } catch {}
      }

      try {
        const items = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (items.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const spinner = ora("Running 6-tier closure verification...").start();
        const clusters = findDuplicateClusters(ctx.store, items, {
          threshold: ctx.config.thresholds.duplicate_similarity,
          repo: ctx.repoFull,
          includeBotAuthors: ctx.config.cluster.include_bot_authors,
          botAuthors: new Set(ctx.config.cluster.bot_authors),
        });

        const relResult = discoverRelationshipCandidates(items, clusters, {
          repo: ctx.repoFull,
        });

        const itemMap = new Map<number, PRItem>();
        for (const item of items) {
          itemMap.set(item.number, item);
        }

        const candidateRecords: ClosureCandidateRecord[] = [];
        for (const rel of relResult.candidates) {
          const sourceItem = itemMap.get(rel.sourceNumber);
          const targetItem = itemMap.get(rel.targetNumber);
          if (!sourceItem || !targetItem) continue;

          const jevDecision = jevStore?.getDecision(
            ctx.repoFull,
            (sourceItem.type as "pr" | "issue") || "pr",
            sourceItem.number,
          );
          const dupNoul = extractNoul(jevDecision?.rawAnswers?.duplicate_candidate);
          const resNoul = extractNoul(jevDecision?.rawAnswers?.already_resolved_candidate);

          const record = buildClosureCandidateRecord(sourceItem, targetItem, {
            embeddingSimilarity: rel.embeddingSimilarity ?? null,
            closingEdgeConfirmed:
              rel.evidenceTier === "DETERMINISTIC" || rel.evidenceFactors.includes("closes_reference"),
            jevDecision: jevDecision
              ? {
                  duplicateCandidateNoul: dupNoul,
                  alreadyResolvedNoul: resNoul,
                  confidence: jevDecision.classification.categoryConfidence ?? undefined,
                  model: jevDecision.provenance.model,
                }
              : undefined,
          });

          candidateRecords.push(record);
        }

        const exported = exportClosureCandidates(candidateRecords, ctx.repoFull);
        spinner.succeed(
          `Closure verification complete: ${exported.verifiedCandidates} verified, ${exported.pendingManualReview} pending review`,
        );

        if (opts.out) {
          ensureParentDir(opts.out);
          writeFileSync(opts.out, `${JSON.stringify(exported, null, 2)}\n`);
          console.log(chalk.green(`✓ Closure candidate export written to ${opts.out}`));
        }

        if (opts.json) {
          console.log(JSON.stringify(exported, null, 2));
        } else if (!opts.out) {
          console.log(chalk.bold("\nClosure Evidence Taxonomy:"));
          for (const [cls, count] of Object.entries(exported.byEvidenceClass)) {
            console.log(`  - ${cls}: ${count}`);
          }
          console.log(chalk.dim(`\nTotal verified: ${exported.verifiedCandidates} (pending maintainer approval)`));
          console.log(chalk.dim(`Pending review: ${exported.pendingManualReview}`));
        }
      } finally {
        jevStore?.close();
        ctx.store.close();
      }
    });

  // 3. calibrate
  housekeeping
    .command("calibrate")
    .description("Calibrate item priority with P0 negative controls (prevents false escalation)")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-o, --out <path>", "Output file path (e.g. reports/calibrated-priority.json)")
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--json", "Output JSON to stdout")
    .action(async (opts) => {
      const dbPath = getDatabasePath(opts.db);
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow("Database not initialized. Run 'prism init' or 'prism scan' first."));
        return;
      }

      const ctx = await createPipelineContext(opts.repo, { dbPath });
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      let jevStore: JevDecisionStore | undefined;
      if (existsSync(decisionsDbPath)) {
        try {
          jevStore = new JevDecisionStore(decisionsDbPath);
        } catch {}
      }

      try {
        const items = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (items.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const spinner = ora("Calibrating item priorities...").start();
        const calibratedItems = items.map((item) => {
          const decision = jevStore?.getDecision(ctx.repoFull, (item.type as "pr" | "issue") || "pr", item.number);
          const originalBand =
            decision?.derived?.priorityTier || (decision as any)?.priority_tier || "P3_ROUTINE_LOCAL";
          const originalReasons = decision?.routing?.escalationReasons || [];
          return calibrateItem(item, originalBand, originalReasons, decision as any);
        });

        const bandCounts: Record<string, number> = {};
        for (const c of calibratedItems) {
          bandCounts[c.calibratedBand] = (bandCounts[c.calibratedBand] || 0) + 1;
        }

        spinner.succeed(`Calibrated priorities for ${calibratedItems.length} item(s)`);

        const outputData = {
          schemaVersion: "1.0.0",
          repo: ctx.repoFull,
          calibratedAt: new Date().toISOString(),
          totalItems: calibratedItems.length,
          bandCounts,
          items: calibratedItems,
        };

        if (opts.out) {
          ensureParentDir(opts.out);
          writeFileSync(opts.out, `${JSON.stringify(outputData, null, 2)}\n`);
          console.log(chalk.green(`✓ Calibrated priority export written to ${opts.out}`));
        }

        if (opts.json) {
          console.log(JSON.stringify(outputData, null, 2));
        } else if (!opts.out) {
          console.log(chalk.bold("\nCalibrated Priority Bands:"));
          for (const [band, count] of Object.entries(bandCounts)) {
            console.log(`  - ${band}: ${count}`);
          }
        }
      } finally {
        jevStore?.close();
        ctx.store.close();
      }
    });

  // 4. plan
  housekeeping
    .command("plan")
    .description("Generate reproducible triage plan and review routing schedule")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-o, --out <path>", "Output file path (e.g. reports/triage-plan.json)")
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--queue-db <path>", "Path to durable review queue SQLite database")
    .option("--seed-queue", "Seed review queue with LIGHT, INTERMEDIATE, and COMPLEX review jobs")
    .option("--json", "Output JSON to stdout")
    .action(async (opts) => {
      const dbPath = getDatabasePath(opts.db);
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow("Database not initialized. Run 'prism init' or 'prism scan' first."));
        return;
      }

      const ctx = await createPipelineContext(opts.repo, { dbPath });
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      const queueDbPath = getQueueDatabasePath(opts.queueDb);
      let jevStore: JevDecisionStore | undefined;
      if (existsSync(decisionsDbPath)) {
        try {
          jevStore = new JevDecisionStore(decisionsDbPath);
        } catch {}
      }

      try {
        const items = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (items.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const spinner = ora("Building triage plan...").start();
        const clusters = findDuplicateClusters(ctx.store, items, {
          threshold: ctx.config.thresholds.duplicate_similarity,
          repo: ctx.repoFull,
          includeBotAuthors: ctx.config.cluster.include_bot_authors,
          botAuthors: new Set(ctx.config.cluster.bot_authors),
        });

        // 1. Relationships & Closures
        const relResult = discoverRelationshipCandidates(items, clusters, { repo: ctx.repoFull });
        const itemMap = new Map<number, PRItem>();
        for (const item of items) {
          itemMap.set(item.number, item);
        }

        const verifiedClosureItems = new Map<number, string>();
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

          if (record.closureVerified) {
            verifiedClosureItems.set(
              sourceItem.number,
              `Verified redundancy with #${targetItem.number} (${record.relationship})`,
            );
          }
        }

        // 2. Build TriagePlanInputEntry list
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
        spinner.succeed(
          `Triage plan generated: ${plan.summary.totalItems} items (${plan.summary.totalPRs} PRs, ${plan.summary.totalIssues} Issues)`,
        );

        // 3. Optional Queue Seeding
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
            console.log(chalk.green(`✓ Seeded ${seededCount} review job(s) into queue: ${queueDbPath}`));
          } finally {
            queue.close();
          }
        }

        if (opts.out) {
          ensureParentDir(opts.out);
          writeFileSync(opts.out, `${exportTriagePlanJson(plan)}\n`);
          console.log(chalk.green(`✓ Triage plan written to ${opts.out}`));
        }

        if (opts.json) {
          console.log(exportTriagePlanJson(plan));
        } else if (!opts.out) {
          console.log(chalk.bold("\nTriage Action Groups:"));
          console.log(`  - 1. Closure Candidates: ${plan.summary.closureCandidates}`);
          console.log(`  - 2. Information Requests: ${plan.summary.informationRequests}`);
          console.log(`  - 3. Light Reviews: ${plan.summary.lightReviews}`);
          console.log(`  - 4. Intermediate Reviews: ${plan.summary.intermediateReviews}`);
          console.log(
            `  - 5. Complex Reviews Needed: ${plan.summary.complexReviewsNeeded} (Human / Advanced AI — NOT auto-invoked)`,
          );
          console.log(`  - 6. Maintainer Decisions: ${plan.summary.maintainerDecisions}`);
          console.log(`  - 7. Ready for Maintainer: ${plan.summary.readyForMaintainer}`);
          console.log(
            chalk.dim(
              `\nAvoided Review Calls (deterministic closures only): ${plan.summary.estimatedReviewCallsAvoided}`,
            ),
          );
          console.log(chalk.dim(`Note: ${plan.summary.reviewCallAvoidanceNote}`));
        }
      } finally {
        jevStore?.close();
        ctx.store.close();
      }
    });

  // 5. run
  housekeeping
    .command("run")
    .description("Execute full housekeeping pipeline: relationships → closures → calibrate → plan")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--db <path>", "Path to primary prism SQLite database")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--queue-db <path>", "Path to durable review queue SQLite database")
    .option("--seed-queue", "Seed review queue with review jobs")
    .option("-o, --out-dir <dir>", "Directory to store report artifacts", "reports")
    .action(async (opts) => {
      const outDir = opts.outDir || "reports";
      mkdirSync(resolve(outDir), { recursive: true });

      console.log(chalk.bold("\n🧹 Running PR-Prism v4 Housekeeping Pipeline\n"));

      const planFile = resolve(outDir, "triage-plan.json");
      const relFile = resolve(outDir, "relationships.json");
      const closureFile = resolve(outDir, "closure-candidates.json");
      const calFile = resolve(outDir, "calibrated-priority.json");

      console.log(chalk.blue(`1. Relationships -> ${relFile}`));
      console.log(chalk.blue(`2. Closures -> ${closureFile}`));
      console.log(chalk.blue(`3. Calibration -> ${calFile}`));
      console.log(chalk.blue(`4. Triage Plan -> ${planFile}`));

      const dbPath = getDatabasePath(opts.db);
      const ctx = await createPipelineContext(opts.repo, { dbPath });
      const decisionsDbPath = getDecisionsDatabasePath(opts.decisionsDb);
      const queueDbPath = getQueueDatabasePath(opts.queueDb);

      let jevStore: JevDecisionStore | undefined;
      if (existsSync(decisionsDbPath)) {
        try {
          jevStore = new JevDecisionStore(decisionsDbPath);
        } catch {}
      }

      try {
        const items = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (items.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const clusters = findDuplicateClusters(ctx.store, items, {
          threshold: ctx.config.thresholds.duplicate_similarity,
          repo: ctx.repoFull,
          includeBotAuthors: ctx.config.cluster.include_bot_authors,
          botAuthors: new Set(ctx.config.cluster.bot_authors),
        });

        // Step 1: Relationships
        const relResult = discoverRelationshipCandidates(items, clusters, { repo: ctx.repoFull });
        writeFileSync(relFile, `${JSON.stringify(relResult, null, 2)}\n`);

        // Step 2: Closures
        const itemMap = new Map<number, PRItem>();
        for (const item of items) itemMap.set(item.number, item);

        const candidateRecords: ClosureCandidateRecord[] = [];
        const verifiedClosureItems = new Map<number, string>();
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
        writeFileSync(closureFile, `${JSON.stringify(closureExport, null, 2)}\n`);

        // Step 3: Priority Calibration
        const calibratedItems = items.map((item) => {
          const decision = jevStore?.getDecision(ctx.repoFull, (item.type as "pr" | "issue") || "pr", item.number);
          const originalBand =
            decision?.derived?.priorityTier || (decision as any)?.priority_tier || "P3_ROUTINE_LOCAL";
          const originalReasons = decision?.routing?.escalationReasons || [];
          return calibrateItem(item, originalBand, originalReasons, decision as any);
        });

        const calOutput = {
          schemaVersion: "1.0.0",
          repo: ctx.repoFull,
          calibratedAt: new Date().toISOString(),
          totalItems: calibratedItems.length,
          items: calibratedItems,
        };
        writeFileSync(calFile, `${JSON.stringify(calOutput, null, 2)}\n`);

        // Step 4: Triage Plan
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
        writeFileSync(planFile, `${exportTriagePlanJson(plan)}\n`);

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
            console.log(chalk.green(`✓ Seeded ${seededCount} review job(s) into queue: ${queueDbPath}`));
          } finally {
            queue.close();
          }
        }

        console.log(chalk.bold.green("\n✓ Housekeeping run completed successfully."));
        console.log(`  - Total items analyzed: ${plan.summary.totalItems}`);
        console.log(`  - Verified closures: ${plan.summary.closureCandidates}`);
        console.log(`  - Information requests: ${plan.summary.informationRequests}`);
        console.log(`  - Light reviews: ${plan.summary.lightReviews}`);
        console.log(`  - Intermediate reviews: ${plan.summary.intermediateReviews}`);
        console.log(`  - Complex reviews needed: ${plan.summary.complexReviewsNeeded}`);
        console.log(`  - Ready for maintainer: ${plan.summary.readyForMaintainer}`);
        console.log(`  - Avoided review calls: ${plan.summary.estimatedReviewCallsAvoided}`);
      } finally {
        jevStore?.close();
        ctx.store.close();
      }
    });
}
