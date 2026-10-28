import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getDataDir } from "../cli/shared/paths.js";
import { hash, type Kind } from "./contracts.js";
import { OperationsGitHub } from "./github.js";
import { paidModel, reconcile, runOperations } from "./runner.js";
import { OperationsStore } from "./store.js";

export function renderSnapshot(value: ReturnType<OperationsStore["snapshot"]>, columns = 120, rows = 40): string {
  const time = (seconds: number | null) => (seconds === null ? "N/A" : `${Math.ceil(seconds)}s`);
  const lines = [
    `${value.repo} | ${value.type}`,
    `Current ${value.counts.completed_current ?? 0}/${value.totalOpen} open | missing ${value.missingCurrent} | stale ${value.staleItems} (${value.historicalStale} historical)`,
    `Inventory only ${value.inventoryKnown} | Pending ${value.counts.pending ?? 0} | incomplete evidence ${value.counts.partial ?? 0} | failed ${value.counts.failed ?? 0} | paused ${value.counts.paused ?? 0}`,
    `Externally resolved/skipped ${value.externallyHandled} | active workers ${value.workers.length}`,
    `Requests reserved/attempted ${value.requests.reserved} | uncertain ${value.requests.uncertain} | remaining budget ${value.requests.remainingBudget}`,
    `Throughput ${value.throughput.completedBatchesPerMinute?.toFixed(2) ?? "N/A"} batches/min`,
    `Estimated ETA to budget stop ${time(value.eta.boundedStopSeconds)} | backlog ${time(value.eta.backlogSeconds)} (indicative 0.5x–2x range)`,
    ...value.active.map(
      (a) =>
        `Active ${value.type} #${a.number} | batch ${a.batch ?? "preparing"}/${a.totalBatches} | account ${a.account ?? "preparing"}${a.leaseExpired ? " | lease expired, recovery required" : ""}`,
    ),
    `Runs ${JSON.stringify(value.runs)}`,
    `Checkpoints ${JSON.stringify(value.latestCheckpoints)}`,
    `Rate limit ${JSON.stringify(value.rateLimit)}`,
    `Sync ${JSON.stringify(value.sync)}`,
  ];
  return lines
    .slice(0, Math.max(1, rows - 1))
    .map((s) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, Math.max(1, columns)))
    .join("\n");
}
const accountSchema = z
  .array(
    z
      .object({
        id: z.string().min(1),
        model: z.string().min(1),
        endpoint: z.url().refine((s) => new URL(s).protocol === "https:", "HTTPS endpoint required"),
        keyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      })
      .strict(),
  )
  .min(1)
  .max(3);
export async function operationsCLI(opts: any) {
  if (opts.type !== "pr" && opts.type !== "issue") throw new Error("--type must be pr or issue");
  if (!opts.repo) throw new Error("--repo owner/repo is required for V5 operations");
  if (
    opts.queueDb ||
    opts.top ||
    opts.show ||
    opts.verifyAccounts ||
    opts.model ||
    opts.tier ||
    opts.maxJobs ||
    opts.maxTokens ||
    opts.prsOnly ||
    opts.issuesOnly ||
    opts.deep ||
    opts.openOnly ||
    opts.accountStats ||
    opts.verifyModels ||
    opts.quarantineSmokeTest
  )
    throw new Error("V5 operations cannot be combined with legacy queue/review modes");
  if ([opts.status, opts.dashboard, opts.recover, opts.allOpen].filter(Boolean).length > 1)
    throw new Error("Choose exactly one V5 status, dashboard, recovery or all-open mode");
  if (opts.acknowledgeUncertain && !opts.recover) throw new Error("--acknowledge-uncertain requires --recover");
  if (
    (opts.status || opts.dashboard || opts.recover) &&
    (opts.maxNewCalls !== undefined || opts.resume || opts.dryRun || opts.runId || opts.outputDir)
  )
    throw new Error("Inspection and recovery cannot be combined with execution flags");
  const kind: Kind = opts.type;
  const file = resolve(opts.operationsDb ?? resolve(getDataDir(), "review-operations-v5.sqlite"));
  const inspecting = opts.status || opts.dashboard;
  if (inspecting) {
    const refresh = Number(opts.refresh);
    if (!Number.isFinite(refresh) || refresh < 0.1) throw new Error("--refresh must be >=0.1 seconds");
    const display = () => {
      if (!existsSync(file)) {
        console.log(JSON.stringify({ repo: opts.repo, type: kind, state: "not_initialized", paidCalls: 0 }));
        return;
      }
      const store = new OperationsStore(file, true);
      try {
        const value = store.snapshot(opts.repo, kind);
        if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify(value));
        else {
          if (opts.dashboard) process.stdout.write("\x1b[2J\x1b[H");
          console.log(renderSnapshot(value, process.stdout.columns, process.stdout.rows));
        }
      } finally {
        store.close();
      }
    };
    display();
    if (opts.dashboard && process.stdout.isTTY && !opts.json)
      await new Promise<void>((done) => {
        const timer = setInterval(display, refresh * 1000);
        process.on("SIGWINCH", display);
        const stop = () => {
          clearInterval(timer);
          process.removeListener("SIGWINCH", display);
          process.removeListener("SIGINT", stop);
          done();
        };
        process.once("SIGINT", stop);
      });
    return;
  }
  if (opts.recover) {
    if (opts.allOpen || opts.maxNewCalls !== undefined)
      throw new Error("Recovery is an offline operation; run review separately with an explicit budget");
    const store = new OperationsStore(file);
    try {
      const recovery = store.recover(opts.repo, kind);
      if (opts.acknowledgeUncertain) store.acknowledgeUncertain(opts.repo, kind, opts.acknowledgeUncertain);
      console.log(JSON.stringify({ recovery, ...store.snapshot(opts.repo, kind) }));
    } finally {
      store.close();
    }
    return;
  }
  if (!opts.allOpen) throw new Error("--all-open is required to run V5 operations");
  // Dry run exits before account configuration or provider initialization.
  const budget = Number(opts.maxNewCalls);
  const accounts = opts.dryRun ? [] : accountSchema.parse(JSON.parse(process.env.PRISM_REVIEW_ACCOUNTS ?? "[]"));
  if (!opts.dryRun && (!Number.isSafeInteger(budget) || budget < 0))
    throw new Error("Explicit --max-new-calls nonnegative integer required");
  if (!opts.dryRun && accounts.some((a) => !process.env[a.keyEnv]))
    throw new Error("Missing configured account credential");
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required for read-only inventory");
  if (!opts.dryRun && opts.resume && !opts.runId) throw new Error("--resume requires the original --run-id and budget");
  const store = new OperationsStore(file);
  try {
    const preparedAccounts = accounts.map((a) => ({
      ...a,
      leaseKey: hash([new URL(a.endpoint).origin, process.env[a.keyEnv]]),
    }));
    if (new Set(preparedAccounts.map((a) => a.leaseKey)).size !== preparedAccounts.length)
      throw new Error("Account aliases refer to the same provider credential");
    const source = new OperationsGitHub(process.env.GITHUB_TOKEN);
    await reconcile(store, source, opts.repo, kind);
    let snapshot = store.snapshot(opts.repo, kind);
    if (!opts.dryRun) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      try {
        snapshot = await runOperations({
          store,
          source,
          model: paidModel,
          accounts: preparedAccounts,
          repo: opts.repo,
          kind,
          runId: opts.runId ?? crypto.randomUUID(),
          budget,
          output: resolve(opts.outputDir ?? resolve(getDataDir(), "review-operations-drafts")),
          signal: controller.signal,
        });
      } finally {
        process.removeListener("SIGINT", stop);
      }
    }
    if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify({ ...snapshot, dryRun: Boolean(opts.dryRun) }));
    else console.log(renderSnapshot(snapshot));
  } finally {
    store.close();
  }
}
