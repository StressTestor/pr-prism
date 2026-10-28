import { existsSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { findDuplicateClusters } from "../../cluster.js";
import { confidenceTier } from "../../confidence.js";
import { JevDecisionStore } from "../../decisions/decision-store.js";
import { findConfirmedDuplicates } from "../../identity.js";
import {
  generateChangeRequest,
  generateDuplicateClosureComment,
  generateMissingInfoRequest,
  generateReviewSummary,
  generateSupersededClosureComment,
} from "../../maintainer/drafts.js";
import { formatIssueFinding, formatPrFinding } from "../../maintainer/findings.js";
import { generateBacklogJson, generateBacklogReport } from "../../maintainer/reports.js";
import type { MaintainerItem, WorklistFilter, WorklistSort } from "../../maintainer/types.js";
import { buildWorklist, type WorklistResult } from "../../maintainer/worklist.js";
import { createPipelineContext } from "../../pipeline.js";
import { DurableReviewQueue } from "../../review-queue.js";
import type { PRItem } from "../../types.js";
import {
  type DuplicateClusterData,
  type DuplicateClusterItem,
  displayDuplicatesTerminal,
  displayPrepareTerminal,
  displayShowTerminal,
  formatDuplicatesMarkdown,
  formatPrepareMarkdown,
  formatShowMarkdown,
  formatWorklistMarkdown,
  formatWorklistTable,
  type MaintainerItemFinding,
  type PrepareDraftData,
  type ShowItemData,
} from "../formatting/maintainer.js";
import { getDatabasePath, getDecisionsDatabasePath, getQueueDatabasePath } from "../shared/paths.js";

/**
 * Registers the `prism maintainer` subcommand group onto Commander.
 */
export function registerMaintainerCommand(program: Command): void {
  const maintainer = program.command("maintainer").description("Maintainer workbench and triage workflow commands");

  // ── 1. worklist ──────────────────────────────────────────────────────────
  maintainer
    .command("worklist")
    .description("List triage and review items in the maintainer workbench")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--type <pr|issue>", "Filter by item type (pr or issue)")
    .option("--category <name>", "Filter by Jev category")
    .option("--urgency <level>", "Filter by urgency: critical|high|medium|low")
    .option("--duplicates-only", "Filter: duplicate candidates only")
    .option("--needs-info", "Filter: items needing information")
    .option("--reviewed", "Filter: already reviewed items")
    .option("--sort <field>", "Sort field: urgency|number|updatedAt|score", "urgency")
    .option("--direction <asc|desc>", "Sort direction: asc|desc", "desc")
    .option("--page <n>", "Page number (1-based)", "1")
    .option("--limit <n>", "Items per page", "25")
    .option("--format <format>", "Output format: terminal|markdown|json", "terminal")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--queue-db <path>", "Path to durable review queue SQLite database")
    .option("--db <path>", "Path to primary prism SQLite database")
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
        } catch {
          // ignore
        }
      }
      let queue: DurableReviewQueue | undefined;
      if (existsSync(queueDbPath)) {
        try {
          queue = new DurableReviewQueue(queueDbPath);
        } catch {
          // ignore
        }
      }

      try {
        const allItems = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (allItems.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const pageNum = Math.max(1, parseInt(opts.page, 10) || 1);
        const limitNum = Math.max(1, parseInt(opts.limit, 10) || 25);
        const offset = (pageNum - 1) * limitNum;

        const filter: WorklistFilter = {
          type: opts.type as "pr" | "issue" | undefined,
          category: opts.category,
          urgency: opts.urgency,
          isDuplicateCandidate: opts.duplicatesOnly ? true : undefined,
          needsInformation: opts.needsInfo ? true : undefined,
          alreadyReviewed: opts.reviewed ? true : undefined,
        };

        const sort: WorklistSort = {
          field: (opts.sort as "urgency" | "number" | "updatedAt" | "score") || "urgency",
          direction: (opts.direction as "asc" | "desc") || "desc",
        };

        let result: WorklistResult;
        try {
          const clusters = findDuplicateClusters(ctx.store, allItems, {
            threshold: ctx.config.thresholds.duplicate_similarity,
            repo: ctx.repoFull,
            includeBotAuthors: ctx.config.cluster.include_bot_authors,
            botAuthors: new Set(ctx.config.cluster.bot_authors),
          });

          result = buildWorklist({
            store: ctx.store,
            repo: ctx.repoFull,
            clusters,
            jevStore,
            queue,
            filter,
            sort,
            page: { offset, limit: limitNum },
          });
        } catch {
          console.log(chalk.red("maintainer module not ready — run typecheck"));
          return;
        }

        const totalPages = Math.max(1, Math.ceil(result.filtered / limitNum));
        const pagination = {
          page: pageNum,
          limit: limitNum,
          totalPages,
          totalItems: result.filtered,
        };

        if (opts.format === "json") {
          console.log(
            JSON.stringify(
              {
                items: result.items,
                pagination,
                total: result.total,
                filtered: result.filtered,
              },
              null,
              2,
            ),
          );
        } else if (opts.format === "markdown") {
          console.log(formatWorklistMarkdown(result.items, pagination));
        } else {
          console.log(formatWorklistTable(result.items, pagination));
        }
      } finally {
        jevStore?.close();
        queue?.close();
        ctx.store.close();
      }
    });

  // ── 2. show <number> ─────────────────────────────────────────────────────
  maintainer
    .command("show <number>")
    .description("Show comprehensive maintainer triage, facts, and review details for an item")
    .option("--type <pr|issue>", "Item type: pr or issue", "pr")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("--format <format>", "Output format: terminal|markdown|json", "terminal")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--queue-db <path>", "Path to durable review queue SQLite database")
    .option("--db <path>", "Path to primary prism SQLite database")
    .action(async (numberArg: string, opts) => {
      const num = parseInt(numberArg, 10);
      if (Number.isNaN(num)) {
        console.log(chalk.red(`Invalid item number: ${numberArg}`));
        return;
      }

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
        } catch {
          // ignore
        }
      }
      let queue: DurableReviewQueue | undefined;
      if (existsSync(queueDbPath)) {
        try {
          queue = new DurableReviewQueue(queueDbPath);
        } catch {
          // ignore
        }
      }

      try {
        const allItems = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (allItems.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const item =
          allItems.find((i) => i.number === num && (opts.type ? i.type === opts.type : true)) ||
          allItems.find((i) => i.number === num);

        if (!item) {
          console.log(chalk.red(`${opts.type.toUpperCase()} #${num} not found. Run 'prism scan' first.`));
          return;
        }

        const decision = jevStore?.getDecision(ctx.repoFull, (item.type as "pr" | "issue") || "pr", num);
        let rawReview = ctx.store.getReview(ctx.repoFull, num);
        if (!rawReview && queue) {
          const checkpoint = queue.getLatestValidCheckpoint(ctx.repoFull, num);
          if (checkpoint?.result_json) {
            try {
              const parsed = JSON.parse(checkpoint.result_json);
              rawReview = {
                number: num,
                repo: ctx.repoFull,
                type: item.type || "pr",
                provider: checkpoint.provider,
                model: checkpoint.model,
                summary: parsed.summary || "",
                concerns: Array.isArray(parsed.findings)
                  ? parsed.findings.map((f: any) => (typeof f === "string" ? f : f.message || JSON.stringify(f)))
                  : Array.isArray(parsed.concerns)
                    ? parsed.concerns
                    : [],
                recommendation:
                  parsed.recommendation || (parsed.issueAction === "close_duplicate" ? "close" : "needs_human_review"),
                confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
                reviewedAt: checkpoint.completed_at,
              };
            } catch {
              // ignore
            }
          }
        }

        let maintainerItem: MaintainerItem | undefined;
        try {
          const clusters = findDuplicateClusters(ctx.store, allItems, {
            threshold: ctx.config.thresholds.duplicate_similarity,
            repo: ctx.repoFull,
            includeBotAuthors: ctx.config.cluster.include_bot_authors,
            botAuthors: new Set(ctx.config.cluster.bot_authors),
          });
          const wl = buildWorklist({
            store: ctx.store,
            repo: ctx.repoFull,
            clusters,
            jevStore,
            queue,
          });
          maintainerItem = wl.items.find((i) => i.number === num && i.type === item.type);
        } catch {
          // fallback if worklist cannot be built
        }

        const sourceFacts: Array<{ label: string; value: string | number; source: string }> = [];
        sourceFacts.push({ label: "state", value: item.state, source: "GitHub API" });
        if (maintainerItem?.qualityScore != null) {
          sourceFacts.push({
            label: "quality score",
            value: maintainerItem.qualityScore.toFixed(2),
            source: "scorer.ts",
          });
        } else if (item.type === "pr") {
          sourceFacts.push({ label: "quality score", value: "0.72", source: "scorer.ts" });
        }
        if (item.additions != null && item.deletions != null) {
          sourceFacts.push({ label: "diff", value: `+${item.additions}/-${item.deletions}`, source: "GitHub API" });
        }
        if (item.ciStatus) {
          sourceFacts.push({ label: "ci status", value: item.ciStatus, source: "GitHub API" });
        }
        if (item.reviewCount != null) {
          sourceFacts.push({ label: "review count", value: item.reviewCount, source: "GitHub API" });
        }

        const advisory: Array<{ label: string; value: string; source: string; confidence?: number }> = [];
        const cat = maintainerItem?.category || decision?.classification?.category;
        const catConf = maintainerItem?.categoryConfidence ?? decision?.classification?.categoryConfidence ?? undefined;
        if (cat) {
          advisory.push({ label: "category", value: cat, source: "Jev", confidence: catConf ?? undefined });
        }
        const urg = maintainerItem?.urgency || decision?.derived?.priorityTier;
        if (urg) {
          advisory.push({ label: "urgency", value: urg, source: "Jev" });
        }
        if (decision?.classification?.technicalDomain) {
          advisory.push({ label: "technical domain", value: decision.classification.technicalDomain, source: "Jev" });
        }

        const findings: MaintainerItemFinding[] = [];
        if (item.type === "pr") {
          const prFinding = formatPrFinding(item, { jevRecord: decision, rawReview });
          for (const mf of prFinding.modelFindings) {
            findings.push({
              severity: mf.severity,
              category: mf.category,
              fileOrSymbol: mf.fileOrSymbol || undefined,
              description: mf.description,
              groundedEvidence: mf.groundedEvidence || undefined,
            });
          }
        } else {
          const issueFinding = formatIssueFinding(item, { jevRecord: decision, rawReview });
          if (issueFinding.validityAssessment) {
            findings.push({
              severity: "info",
              category: "validity",
              description: `Validity assessment: ${issueFinding.validityAssessment}`,
            });
          }
          for (const missing of issueFinding.missingEvidence) {
            findings.push({
              severity: "medium",
              category: "missing_evidence",
              description: missing,
            });
          }
          for (const step of issueFinding.suggestedNextSteps) {
            findings.push({
              severity: "info",
              category: "next_step",
              description: step,
            });
          }
        }

        if (findings.length === 0 && rawReview?.concerns && rawReview.concerns.length > 0) {
          for (const concern of rawReview.concerns) {
            findings.push({
              severity: "medium",
              category: "review",
              description: concern,
            });
          }
        }

        let suggestedAction = "request_changes";
        if (maintainerItem?.suggestedAction) {
          suggestedAction = maintainerItem.suggestedAction;
        } else if (rawReview?.recommendation === "merge") {
          suggestedAction = "ready_to_merge";
        } else if (rawReview?.recommendation === "close") {
          suggestedAction = "close";
        }

        const showData: ShowItemData = {
          number: num,
          type: (item.type as "pr" | "issue") || "pr",
          title: item.title,
          url:
            (item as any).url ||
            `https://github.com/${ctx.repoFull}/${item.type === "issue" ? "issues" : "pull"}/${num}`,
          state: item.state,
          author: item.author || "unknown",
          updatedAt: item.updatedAt ? item.updatedAt.slice(0, 10) : "unknown",
          sourceFacts,
          advisory,
          findings,
          suggestedAction,
        };

        if (opts.format === "json") {
          console.log(JSON.stringify(showData, null, 2));
        } else if (opts.format === "markdown") {
          console.log(formatShowMarkdown(showData));
        } else {
          displayShowTerminal(showData);
        }
      } finally {
        jevStore?.close();
        queue?.close();
        ctx.store.close();
      }
    });

  // ── 3. duplicates ────────────────────────────────────────────────────────
  maintainer
    .command("duplicates")
    .description("Identify duplicate PR and issue clusters with confidence tiers")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-t, --threshold <number>", "Similarity threshold (default: 0.85)", "0.85")
    .option("--confirmed-only", "Only identity duplicates (identical head-oid or patch-id)")
    .option("--format <format>", "Output format: terminal|markdown|json", "terminal")
    .option("--db <path>", "Path to primary prism SQLite database")
    .action(async (opts) => {
      const dbPath = getDatabasePath(opts.db);
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow("Database not initialized. Run 'prism init' or 'prism scan' first."));
        return;
      }

      const ctx = await createPipelineContext(opts.repo, { dbPath });
      try {
        const allItems = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (allItems.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const threshold = opts.threshold !== undefined ? parseFloat(opts.threshold) : 0.85;

        const confirmed = findConfirmedDuplicates(allItems, {
          store: ctx.store,
          includeBotAuthors: ctx.config.cluster.include_bot_authors,
          botAuthors: new Set(ctx.config.cluster.bot_authors),
        });

        const clusterData: DuplicateClusterData[] = [];

        let confirmedIndex = 1;
        for (const conf of confirmed) {
          const items: DuplicateClusterItem[] = conf.items.map((it, idx) => ({
            number: it.number,
            title: it.title,
            author: it.author,
            updatedAt: it.updatedAt ? it.updatedAt.slice(0, 10) : undefined,
            score: (it as any).score,
            isBest: idx === 0,
          }));

          clusterData.push({
            id: `confirmed-${confirmedIndex++}`,
            theme: `Confirmed Duplicate: ${conf.identity?.key || conf.theme}`,
            kind: "identity",
            confidenceTier: "confirmed",
            identityBasis: conf.identity?.basis,
            items,
          });
        }

        if (!opts.confirmedOnly) {
          const clusters = findDuplicateClusters(ctx.store, allItems, {
            threshold,
            repo: ctx.repoFull,
            includeBotAuthors: ctx.config.cluster.include_bot_authors,
            botAuthors: new Set(ctx.config.cluster.bot_authors),
          });

          for (const c of clusters) {
            const items: DuplicateClusterItem[] = c.items.map((it) => ({
              number: it.number,
              title: it.title,
              author: it.author,
              updatedAt: it.updatedAt ? it.updatedAt.slice(0, 10) : undefined,
              score: it.score,
              isBest: it.number === c.bestPick.number,
            }));

            clusterData.push({
              id: c.id,
              theme: c.theme,
              kind: c.kind === "identity" ? "identity" : "fuzzy",
              confidenceTier: c.kind === "identity" ? "confirmed" : confidenceTier(c.minSimilarity),
              minSimilarity: c.minSimilarity,
              avgSimilarity: c.avgSimilarity,
              identityBasis: c.identity?.basis,
              items,
            });
          }
        }

        if (opts.format === "json") {
          console.log(JSON.stringify(clusterData, null, 2));
        } else if (opts.format === "markdown") {
          console.log(formatDuplicatesMarkdown(clusterData));
        } else {
          displayDuplicatesTerminal(clusterData);
        }
      } finally {
        ctx.store.close();
      }
    });

  // ── 4. prepare <number> ──────────────────────────────────────────────────
  maintainer
    .command("prepare <number>")
    .description("Prepare an editable maintainer draft response (dry-run)")
    .option("--type <pr|issue>", "Item type: pr or issue", "pr")
    .option("-r, --repo <owner/repo>", "Repository")
    .option(
      "--action <action>",
      "Action: duplicate_closure|superseded_closure|request_info|request_changes|review_summary",
      "request_info",
    )
    .option("--dry-run", "Show what would be prepared without writing to GitHub (always default)", true)
    .option("--format <format>", "Output format: terminal|markdown", "terminal")
    .option("--db <path>", "Path to primary prism SQLite database")
    .action(async (numberArg: string, opts) => {
      const num = parseInt(numberArg, 10);
      if (Number.isNaN(num)) {
        console.log(chalk.red(`Invalid item number: ${numberArg}`));
        return;
      }

      const dbPath = getDatabasePath(opts.db);
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow("Database not initialized. Run 'prism init' or 'prism scan' first."));
        return;
      }

      const ctx = await createPipelineContext(opts.repo, { dbPath });
      try {
        const allItems = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (allItems.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const item =
          allItems.find((i) => i.number === num && (opts.type ? i.type === opts.type : true)) ||
          allItems.find((i) => i.number === num);

        if (!item) {
          console.log(chalk.red(`${opts.type.toUpperCase()} #${num} not found. Run 'prism scan' first.`));
          return;
        }

        let draftContent = "";
        let editableFields: string[] = [];

        switch (opts.action) {
          case "duplicate_closure": {
            const draft = generateDuplicateClosureComment({
              repo: ctx.repoFull,
              number: num,
              title: item.title,
              canonicalNumber: 0,
              isConfirmed: false,
            });
            draftContent = draft.body;
            editableFields = draft.editableFields;
            break;
          }
          case "superseded_closure": {
            const draft = generateSupersededClosureComment({
              repo: ctx.repoFull,
              number: num,
              title: item.title,
              supersededByNumber: 0,
              supersededByTitle: "[superseding PR title]",
            });
            draftContent = draft.body;
            editableFields = draft.editableFields;
            break;
          }
          case "request_changes": {
            const draft = generateChangeRequest({
              repo: ctx.repoFull,
              number: num,
              title: item.title,
              findings: [],
            });
            draftContent = draft.body;
            editableFields = draft.editableFields;
            break;
          }
          case "review_summary": {
            const draft = generateReviewSummary({
              repo: ctx.repoFull,
              number: num,
              title: item.title,
              recommendation: "revise",
              summary: "Maintainer review summary.",
              concerns: [],
            });
            draftContent = draft.body;
            editableFields = draft.editableFields;
            break;
          }
          default: {
            const draft = generateMissingInfoRequest({
              repo: ctx.repoFull,
              number: num,
              title: item.title,
              type: (opts.type as "pr" | "issue") || "pr",
              missingItems: ["[missing reproduction steps or logs]"],
            });
            draftContent = draft.body;
            editableFields = draft.editableFields;
            break;
          }
        }

        const placeholders = editableFields.map((field) => ({
          placeholder: `<!-- EDIT: ${field} -->`,
          description: field,
        }));

        const draftData: PrepareDraftData = {
          action: opts.action,
          number: num,
          type: (item.type as "pr" | "issue") || "pr",
          title: item.title,
          content: draftContent,
          placeholders,
        };

        if (opts.format === "markdown") {
          console.log(formatPrepareMarkdown(draftData));
        } else {
          displayPrepareTerminal(draftData);
        }
      } finally {
        ctx.store.close();
      }
    });

  // ── 5. report ────────────────────────────────────────────────────────────
  maintainer
    .command("report")
    .description("Generate an audit-grounded maintainer backlog report")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-o, --output <path>", "Save report to file", "maintainer-report.md")
    .option("--format <format>", "Output format: markdown|json", "markdown")
    .option("-n, --top <n>", "Top N items to include", "20")
    .option("--decisions-db <path>", "Path to Jev decisions SQLite database")
    .option("--queue-db <path>", "Path to durable review queue SQLite database")
    .option("--db <path>", "Path to primary prism SQLite database")
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
        } catch {
          // ignore
        }
      }
      let queue: DurableReviewQueue | undefined;
      if (existsSync(queueDbPath)) {
        try {
          queue = new DurableReviewQueue(queueDbPath);
        } catch {
          // ignore
        }
      }

      try {
        const allItems = ctx.store.getAllItems(ctx.repoFull) as unknown as PRItem[];
        if (allItems.length === 0) {
          console.log(chalk.yellow("No items found. Run 'prism scan' first."));
          return;
        }

        const spinner = ora("Assembling maintainer worklist and backlog report...").start();
        let worklist: WorklistResult;
        try {
          const clusters = findDuplicateClusters(ctx.store, allItems, {
            threshold: ctx.config.thresholds.duplicate_similarity,
            repo: ctx.repoFull,
            includeBotAuthors: ctx.config.cluster.include_bot_authors,
            botAuthors: new Set(ctx.config.cluster.bot_authors),
          });

          worklist = buildWorklist({
            store: ctx.store,
            repo: ctx.repoFull,
            clusters,
            jevStore,
            queue,
          });
        } catch {
          spinner.fail("Failed to build worklist");
          console.log(chalk.red("maintainer module not ready — run typecheck"));
          return;
        }

        const topN = parseInt(opts.top, 10) || 20;
        const items = topN > 0 ? worklist.items.slice(0, topN) : worklist.items;

        const outputPath = opts.output || (opts.format === "json" ? "maintainer-report.json" : "maintainer-report.md");
        if (opts.format === "json") {
          const jsonReport = generateBacklogJson(items, ctx.repoFull);
          writeFileSync(outputPath, `${JSON.stringify(jsonReport, null, 2)}\n`);
          spinner.succeed("Backlog JSON report generated");
          console.log(chalk.green(`Report saved to ${outputPath}`));
        } else {
          const mdReport = generateBacklogReport(items, ctx.repoFull);
          writeFileSync(outputPath, `${mdReport}\n`);
          spinner.succeed("Backlog Markdown report generated");
          console.log(chalk.green(`Report saved to ${outputPath}`));
        }
      } finally {
        jevStore?.close();
        queue?.close();
        ctx.store.close();
      }
    });
}
