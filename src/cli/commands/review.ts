import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { getRepos, loadConfig, loadEnvConfig, parseRepo } from "../../config.js";
import { assertReadOnlyGitHubClient, reviewIssueDeep, reviewPRDeep } from "../../deep-reviewer.js";
import { createEmbeddingProvider } from "../../embeddings.js";
import { GitHubClient } from "../../github.js";
import { DEFAULT_FEATHERLESS_TIERS, type ReviewTier, validateModelAvailability } from "../../review/model-registry.js";
import { operationsCLI } from "../../review-operations/cli.js";
import { DurableReviewQueue } from "../../review-queue.js";
import {
  loadMultiAccountProfilesFromEnv,
  MultiProviderReviewScheduler,
  resolveAccountCredential,
  verifyAccountsIndependently,
} from "../../review-scheduler.js";
import { reviewPR } from "../../reviewer.js";
import { VectorStore } from "../../store.js";
import type { PRItem, ReviewResult } from "../../types.js";
import { displayReview } from "../formatting/review.js";

export function registerReviewCommand(program: Command): void {
  program
    .command("review [number]")
    .description("Deep LLM review of a PR or issue")
    .option("-m, --model <model>", "Override LLM model")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-n, --top <number>", "Batch review top N ranked items")
    .option("--show <number>", "Show a previously saved review")
    .option("--type <type>", "Item type: pr or issue", "pr")
    .option("--operations", "Select V5 operations (use with --status for offline inspection)")
    .option("--recover", "V5: recover expired local workers without inference")
    .option(
      "--acknowledge-uncertain <attempt-id>",
      "V5 recovery: authorize retry planning for one uncertain charged request",
    )
    .option("--all-open", "V5: reconcile and review every open item")
    .option("--operations-db <path>", "Dedicated V5 operations database (never a V4 queue)")
    .option("--max-new-calls <number>", "V5: maximum outbound attempts, including failures")
    .option("--run-id <id>", "V5: durable budget identity; required with --resume")
    .option("--output-dir <path>", "V5: immutable local JSON/Markdown manifests")
    .option("--dashboard", "V5: read-only terminal dashboard")
    .option("--refresh <seconds>", "Dashboard refresh interval", "5")
    .option("--deep", "Use Stage E grounded deep review schema (PR diff findings / dedicated Issue schema)")
    .option("--verify-accounts", "Verify multi-account provider credentials independently before execution")
    .option("--queue-db <path>", "Run or inspect durable multi-provider SQLite review queue")
    .option("--json", "Output results as JSON")
    .option("--dry-run", "Show what would be processed without making any LLM API calls")
    .option("--max-jobs <number>", "Hard cap on number of LLM calls in this run (safety gate for smoke tests)")
    .option("--tier <tier>", "Force review tier: light | intermediate | complex")
    .option("--status", "Show queue status, active leases, recent failures, and per-account utilization")
    .option("--resume", "Resume processing from last state skipping completed checkpoints")
    .option("--prs-only", "Only process PR items from the queue")
    .option("--issues-only", "Only process issue items from the queue")
    .option("--open-only", "Only process open items from the queue")
    .option("--account-stats", "Show per-account utilization breakdown and exit")
    .option("--verify-models", "Verify configured models exist on provider metadata endpoint before execution")
    .option("--max-tokens <number>", "Override output token budget (e.g. 8192, 12288)")
    .option(
      "--quarantine-smoke-test",
      "Quarantine historical invalid smoke test checkpoints (PR #6357, Issue #1940, Issue #6224)",
    )
    .action(async (numberArg: string | undefined, opts) => {
      if (
        opts.operations ||
        opts.recover ||
        opts.acknowledgeUncertain ||
        opts.allOpen ||
        opts.dashboard ||
        opts.operationsDb ||
        opts.maxNewCalls !== undefined ||
        opts.runId ||
        opts.outputDir
      ) {
        if (numberArg) throw new Error("V5 operations cannot be combined with a single item number");
        await operationsCLI(opts);
        return;
      }
      if (opts.status && !opts.queueDb) throw new Error("--status requires --queue-db for V4, or --operations for V5");
      // 1. Preflight account credentials verification
      if (opts.verifyAccounts) {
        const profiles = loadMultiAccountProfilesFromEnv(process.env);
        const report = await verifyAccountsIndependently(profiles);
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(
            chalk.bold(
              `Pre-flight Account Verification (${report.activeAccountCount}/${report.totalAccountCount} active):`,
            ),
          );
          for (const acct of report.accounts) {
            const badge = acct.ok ? chalk.green("PASS") : chalk.red(`FAIL (${acct.status})`);
            console.log(
              `  - ${acct.accountId} [${acct.provider}/${acct.model}] key_sha256=${acct.keyFingerprint}: ${badge} (${acct.latencyMs}ms)${
                acct.errorMessage ? ` — ${acct.errorMessage}` : ""
              }`,
            );
          }
        }
        if (!report.allAuthenticated) {
          process.exitCode = 1;
        }
        return;
      }

      // 2. Queue-based multi-account scheduling & inspection operations
      if (opts.queueDb) {
        const queue = new DurableReviewQueue(opts.queueDb);
        try {
          // 2a. Quarantine historical failed smoke tests
          if (opts.quarantineSmokeTest) {
            const knownSmokeIds = ["facebook/react:pr:6357", "facebook/react:issue:1940", "facebook/react:issue:6224"];
            // Also search for any matching item numbers in the queue
            const allJobs = queue.listJobs();
            const matchingJobIds = allJobs
              .filter(
                (j) =>
                  (j.item_number === 6357 && j.item_type === "pr") ||
                  (j.item_number === 1940 && j.item_type === "issue") ||
                  (j.item_number === 6224 && j.item_type === "issue") ||
                  knownSmokeIds.includes(j.job_id),
              )
              .map((j) => j.job_id);

            const idsToQuarantine = Array.from(new Set([...knownSmokeIds, ...matchingJobIds]));
            const count = queue.quarantineSmokeTestCheckpoints(idsToQuarantine);
            if (opts.json) {
              console.log(JSON.stringify({ quarantinedJobs: count, jobIds: idsToQuarantine }, null, 2));
            } else {
              console.log(
                chalk.yellow(`Quarantined ${count} historical smoke test checkpoints into 'invalid' status.`),
              );
            }
            return;
          }

          // 2b. Status inspection (without inference)
          if (opts.status) {
            const stats = queue.getQueueStats();
            const usage = queue.getUsageSummaryByAccount();
            const recentFailures = queue.listRecentFailures(5);
            const activeLeases = queue.listActiveLeases();

            if (opts.json) {
              console.log(JSON.stringify({ stats, usage, activeLeases, recentFailures }, null, 2));
            } else {
              console.log(chalk.bold("\nDurable Review Queue Status:"));
              console.log(`  Queued:             ${stats.queued}`);
              console.log(`  Claimed:            ${stats.claimed}`);
              console.log(`  Completed:          ${chalk.green(stats.completed)}`);
              console.log(`  Failed:             ${chalk.red(stats.failed)}`);
              console.log(`  Rejected Permanent: ${chalk.red(stats.rejected_permanent)}`);
              console.log(`  Quarantined Invalid:${chalk.yellow(stats.invalid)}`);
              console.log(`  Total:              ${stats.total}`);

              console.log(chalk.bold("\nActive Leases:"), activeLeases.length);
              for (const l of activeLeases) {
                console.log(
                  `  - ${l.account_id} -> ${l.job_id} (expires in ${Math.round((l.expires_at - Date.now()) / 1000)}s)`,
                );
              }

              console.log(chalk.bold("\nAccount Utilization:"));
              for (const [acctId, sum] of Object.entries(usage)) {
                console.log(
                  `  - ${chalk.cyan(acctId)}: ${sum.totalRequests} reqs (${chalk.green(sum.successCount)} ok, ${chalk.red(sum.failureCount)} err) | ${sum.promptTokens} prompt / ${sum.completionTokens} completion tokens | last seen: ${sum.lastSeen || "never"}`,
                );
              }

              if (recentFailures.length > 0) {
                console.log(chalk.bold("\nRecent Failures:"));
                for (const f of recentFailures) {
                  console.log(`  - [${f.status}] ${f.job_id}: ${f.last_error || "unknown error"}`);
                }
              }
            }
            return;
          }

          // 2c. Account stats only
          if (opts.accountStats) {
            const usage = queue.getUsageSummaryByAccount();
            if (opts.json) {
              console.log(JSON.stringify(usage, null, 2));
            } else {
              console.log(chalk.bold("Account Utilization Summary:"));
              for (const [acctId, sum] of Object.entries(usage)) {
                console.log(
                  `  Account: ${chalk.cyan(acctId)}\n    Requests:    ${sum.totalRequests} (${sum.successCount} success, ${sum.failureCount} failed)\n    Tokens:      ${sum.promptTokens} prompt | ${sum.completionTokens} completion\n    Last active: ${sum.lastSeen || "never"}`,
                );
              }
            }
            return;
          }

          // 2d. Dry run inspection
          if (opts.dryRun) {
            const filterType = opts.prsOnly ? "pr" : opts.issuesOnly ? "issue" : undefined;
            const queuedJobs = queue.listJobsByFilter({
              itemType: filterType,
              status: ["queued"],
              isOpen: opts.openOnly ? true : undefined,
            });

            const tierName: ReviewTier = (opts.tier as ReviewTier) || "complex";
            const tierConfig = DEFAULT_FEATHERLESS_TIERS[tierName] || DEFAULT_FEATHERLESS_TIERS.complex;

            const maxTokens = opts.maxTokens ? parseInt(opts.maxTokens, 10) : tierConfig.maxOutputTokens;
            const maxJobsCap = opts.maxJobs ? parseInt(opts.maxJobs, 10) : queuedJobs.length;
            const willProcessCount = Math.min(maxJobsCap, queuedJobs.length);

            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    dryRun: true,
                    totalQueued: queuedJobs.length,
                    plannedProcessingCount: willProcessCount,
                    tier: tierName,
                    model: opts.model || tierConfig.modelId,
                    maxOutputTokens: maxTokens,
                    jobs: queuedJobs.slice(0, willProcessCount).map((j) => ({
                      jobId: j.job_id,
                      itemType: j.item_type,
                      itemNumber: j.item_number,
                      title: j.title,
                      priorityBand: j.priority_band,
                      priorityScore: j.priority_score,
                    })),
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(chalk.bold("\n--- Review Queue Dry-Run ---"));
              console.log(`  Matching queued jobs:   ${queuedJobs.length}`);
              console.log(`  Planned to process:     ${willProcessCount} (max-jobs cap: ${opts.maxJobs || "none"})`);
              console.log(`  Configured tier:        ${chalk.cyan(tierName)} [${tierConfig.modelId}]`);
              console.log(`  Output token budget:    ${maxTokens} tokens / job`);
              console.log(`  Zero LLM calls made. Zero database mutations recorded.\n`);
              for (const j of queuedJobs.slice(0, 10)) {
                console.log(`  - [${j.priority_band}] ${j.job_id}: ${j.title.slice(0, 60)}`);
              }
              if (willProcessCount > 10) {
                console.log(`  ... and ${willProcessCount - 10} more jobs`);
              }
            }
            return;
          }

          // 2e. Execute scheduler across configured accounts
          let profiles = loadMultiAccountProfilesFromEnv(process.env);
          if (profiles.length === 0) {
            console.error(chalk.red("No provider account profiles configured in environment."));
            process.exitCode = 1;
            return;
          }

          // Override tier/model/token budget if specified via flags
          if (opts.tier) {
            const requestedTier = opts.tier as ReviewTier;
            const tierConfig = DEFAULT_FEATHERLESS_TIERS[requestedTier];
            if (!tierConfig) {
              console.error(chalk.red(`Invalid tier '${opts.tier}'. Must be light, intermediate, or complex.`));
              process.exitCode = 1;
              return;
            }
            profiles = profiles.map((p) => ({
              ...p,
              tier: requestedTier,
              model: opts.model || tierConfig.modelId,
              outputTokens: opts.maxTokens ? parseInt(opts.maxTokens, 10) : tierConfig.maxOutputTokens,
            }));
          } else if (opts.model || opts.maxTokens) {
            profiles = profiles.map((p) => ({
              ...p,
              model: opts.model || p.model,
              outputTokens: opts.maxTokens ? parseInt(opts.maxTokens, 10) : p.outputTokens,
            }));
          }

          // Verify model availability if requested
          if (opts.verifyModels) {
            for (const profile of profiles) {
              const cred = resolveAccountCredential(profile);
              if (cred?.apiKey) {
                const availability = await validateModelAvailability(profile.model, cred.apiKey, profile.baseUrl);
                if (!availability.available) {
                  console.error(
                    chalk.red(
                      `Launch Gate Blocker: Model '${profile.model}' on account '${profile.accountId}' is not available: ${availability.error}`,
                    ),
                  );
                  process.exitCode = 1;
                  return;
                }
              }
            }
          }

          // Verify preflight authentication
          const preflight = await verifyAccountsIndependently(profiles);
          if (!preflight.allAuthenticated) {
            console.error(
              chalk.yellow(
                `Launch Gate 3 Blocker: Only ${preflight.activeAccountCount}/${preflight.totalAccountCount} configured accounts authenticated. Leaving durable queue resumable without launching unattended batch.`,
              ),
            );
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    launchGateBlocked: true,
                    preflight,
                    stats: queue.getQueueStats(),
                    usage: queue.getUsageSummaryByAccount(),
                  },
                  null,
                  2,
                ),
              );
            }
            process.exitCode = 2;
            return;
          }

          // Bounded smoke test safety banner
          const maxJobs = opts.maxJobs ? parseInt(opts.maxJobs, 10) : undefined;
          if (maxJobs) {
            console.log(chalk.yellow(`⚠ Bounded run: max ${maxJobs} jobs. This is a SMOKE TEST mode.`));
          } else if (process.stdout.isTTY) {
            console.warn(chalk.yellow("⚠ No --max-jobs limit set. Processing queued items."));
          }

          const filterItemType = opts.prsOnly ? "pr" : opts.issuesOnly ? "issue" : undefined;

          const scheduler = new MultiProviderReviewScheduler(queue, profiles, {
            maxJobs,
            filterItemType,
            filterOpenOnly: opts.openOnly ? true : undefined,
          });

          const runResult = await scheduler.run();
          if (opts.json) {
            console.log(
              JSON.stringify(
                { runResult, stats: queue.getQueueStats(), usage: queue.getUsageSummaryByAccount() },
                null,
                2,
              ),
            );
          } else {
            console.log(chalk.green("Multi-provider review queue run completed:"), runResult);
          }
        } finally {
          queue.close();
        }
        return;
      }

      // 3. Fallback to single item or top-N review using VectorStore
      const config = loadConfig();
      const env = loadEnvConfig();
      const repoStr = opts.repo || config.repo || getRepos(config)[0];
      const { owner, repo } = parseRepo(repoStr);
      const repoFull = `${owner}/${repo}`;

      const github = assertReadOnlyGitHubClient(new GitHubClient(env.GITHUB_TOKEN, owner, repo));
      const embedder = await createEmbeddingProvider({
        provider: env.EMBEDDING_PROVIDER,
        apiKey: env.EMBEDDING_API_KEY,
        model: env.EMBEDDING_MODEL,
        baseUrl: env.EMBEDDING_BASE_URL,
        dimensions: env.EMBEDDING_DIMENSIONS,
      });
      const store = new VectorStore(undefined, embedder.dimensions, env.EMBEDDING_MODEL);

      try {
        // --show: display a saved review
        if (opts.show) {
          const num = parseInt(opts.show, 10);
          const saved = store.getReview(repoFull, num);
          if (!saved) {
            console.log(chalk.red(`No saved review for #${num}. Run \`prism review ${num}\` first.`));
            return;
          }
          if (opts.json) {
            console.log(JSON.stringify(saved));
          } else {
            displayReview(num, `(${saved.type})`, saved, { provider: saved.provider, model: saved.model });
          }
          return;
        }

        // --top N: batch review
        if (opts.top) {
          const topN = parseInt(opts.top, 10) || 5;
          const items = store.getAllItems(repoFull) as unknown as PRItem[];
          const filtered =
            opts.type === "issue" ? items.filter((i) => i.type === "issue") : items.filter((i) => i.type === "pr");
          const sorted = filtered
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .slice(0, topN);

          console.log(chalk.bold(`Reviewing top ${sorted.length} ${opts.type}s...\n`));
          for (const item of sorted) {
            const reviewSpinner = ora(`Reviewing #${item.number}...`).start();
            try {
              let result: ReviewResult;
              if (item.type === "pr") {
                const diff = await github.fetchDiff(item.number, store);
                result = await reviewPR(item.title, item.body, diff, {
                  provider: env.LLM_PROVIDER,
                  apiKey: env.LLM_API_KEY,
                  model: opts.model || env.LLM_MODEL,
                  baseUrl: env.LLM_BASE_URL,
                });
              } else {
                result = await reviewPR(item.title, item.body, "(no diff - this is an issue, not a PR)", {
                  provider: env.LLM_PROVIDER,
                  apiKey: env.LLM_API_KEY,
                  model: opts.model || env.LLM_MODEL,
                  baseUrl: env.LLM_BASE_URL,
                });
              }
              store.saveReview(repoFull, item.number, item.type, env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
              reviewSpinner.succeed(`#${item.number} reviewed`);

              if (opts.json) {
                console.log(JSON.stringify({ number: item.number, type: item.type, ...result }));
              } else {
                displayReview(item.number, item.title, result, {
                  author: item.author,
                  additions: item.additions,
                  deletions: item.deletions,
                });
              }
            } catch (e: any) {
              reviewSpinner.fail(`#${item.number} failed: ${e.message?.slice(0, 80)}`);
            }
          }
          return;
        }

        // Single review
        if (!numberArg) {
          console.error(chalk.red("Provide a PR/issue number, --top N for batch, or --show N for history"));
          process.exit(1);
        }

        const num = parseInt(numberArg, 10);
        const isIssue = opts.type === "issue";

        if (isIssue) {
          // Issue review
          const spinner = ora(`Fetching issue #${num}...`).start();
          const items = store.getAllItems(repoFull) as unknown as PRItem[];
          const issue = items.find((i) => i.number === num && i.type === "issue");
          if (!issue) {
            spinner.fail(`Issue #${num} not found in database. Run \`prism scan\` first.`);
            return;
          }
          spinner.succeed(`Loaded issue #${num}`);

          const reviewSpinner = ora(`Reviewing with ${opts.model || env.LLM_MODEL}...`).start();
          if (opts.deep) {
            const deepResult = await reviewIssueDeep(issue, {
              llmConfig: {
                provider: env.LLM_PROVIDER,
                apiKey: env.LLM_API_KEY,
                model: opts.model || env.LLM_MODEL,
                baseUrl: env.LLM_BASE_URL,
              },
              gitHubClient: github,
            });
            reviewSpinner.succeed("Deep issue review complete");
            if (opts.json) {
              console.log(JSON.stringify(deepResult, null, 2));
            } else {
              console.log(chalk.bold(`\nIssue #${num} Deep Review (${deepResult.issueAction}):`));
              console.log(`  Summary: ${deepResult.summary}`);
              console.log(`  Validity: ${deepResult.validityAssessment}`);
              console.log(`  Root Cause / Design: ${deepResult.rootCauseOrDesignAnalysis}`);
              console.log(`  Confidence: ${deepResult.confidence}`);
            }
            return;
          }
          const result = await reviewPR(issue.title, issue.body, "(no diff - this is an issue, not a PR)", {
            provider: env.LLM_PROVIDER,
            apiKey: env.LLM_API_KEY,
            model: opts.model || env.LLM_MODEL,
            baseUrl: env.LLM_BASE_URL,
          });
          store.saveReview(repoFull, num, "issue", env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
          reviewSpinner.succeed("Review complete");

          if (opts.json) {
            console.log(JSON.stringify({ number: num, type: "issue", ...result }));
          } else {
            displayReview(num, issue.title, result, { author: issue.author });
          }
        } else {
          // PR review
          const spinner = ora(`Fetching PR #${num}...`).start();
          let pr: PRItem;
          try {
            pr = await github.getPR(num);
          } catch {
            spinner.fail(`PR #${num} not found`);
            return;
          }

          spinner.text = `Fetching diff for #${num}...`;
          const diff = await github.fetchDiff(num, store);
          spinner.succeed(`Loaded PR #${num}`);

          const reviewSpinner = ora(`Reviewing with ${opts.model || env.LLM_MODEL}...`).start();
          if (opts.deep) {
            const deepResult = await reviewPRDeep(
              { ...pr, diffText: diff },
              {
                llmConfig: {
                  provider: env.LLM_PROVIDER,
                  apiKey: env.LLM_API_KEY,
                  model: opts.model || env.LLM_MODEL,
                  baseUrl: env.LLM_BASE_URL,
                },
                gitHubClient: github,
              },
            );
            reviewSpinner.succeed("Deep PR review complete");
            if (opts.json) {
              console.log(JSON.stringify(deepResult, null, 2));
            } else {
              console.log(chalk.bold(`\nPR #${num} Deep Review (${deepResult.recommendation}):`));
              console.log(`  Summary: ${deepResult.summary}`);
              console.log(`  Findings: ${deepResult.findings.length}`);
              console.log(`  Confidence: ${deepResult.confidence}`);
            }
            return;
          }
          const result = await reviewPR(pr.title, pr.body, diff, {
            provider: env.LLM_PROVIDER,
            apiKey: env.LLM_API_KEY,
            model: opts.model || env.LLM_MODEL,
            baseUrl: env.LLM_BASE_URL,
          });
          store.saveReview(repoFull, num, "pr", env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
          reviewSpinner.succeed("Review complete");

          if (opts.json) {
            console.log(JSON.stringify({ number: num, type: "pr", ...result }));
          } else {
            displayReview(num, pr.title, result, {
              author: pr.author,
              additions: pr.additions,
              deletions: pr.deletions,
            });
          }
        }
      } finally {
        store.close();
      }
    });
}
