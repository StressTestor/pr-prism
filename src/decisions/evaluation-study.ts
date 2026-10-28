import Database from "better-sqlite3";
import type { PRItem } from "../types.js";
import type { JevDecisionStore } from "./decision-store.js";
import { DEFAULT_JEV_MODEL } from "./jev-provider.js";
import { computeDecisionIdentity, computeRubricHash, computeStateHash } from "./sanitize.js";
import {
  evaluateJevFirstItem,
  JEV_FIRST_QUESTIONS,
  JEV_FIRST_SCHEMA_VERSION,
  type JevFirstDecisionRecord,
  prepareJevFirstState,
} from "./triage-v2.js";
import type { DecisionProvider } from "./types.js";

export interface QwenClassificationRow {
  repo: string;
  itemType: "pr" | "issue";
  itemNumber: number;
  model: string;
  sourceHash: string;
  category: string;
  priority: string;
  complexity: string;
  confidence: number;
  needsDeepReview: boolean;
  riskFlags: string[];
  reason: string;
  escalate: boolean;
  escalationReason: string;
  uncertaintyFlags: string[];
  fullBodyLen: number;
  isInputTruncated: boolean;
  promptTokens: number;
  outputTokens: number;
  elapsedSeconds: number;
  classifiedAt: string;
}

export interface EnrichedEvaluationItem {
  prItem: PRItem;
  fullBodyLength: number;
  qwen?: QwenClassificationRow;
  stratum?: string;
}

/**
 * Loads open items from canonical PR-Prism SQLite DB, attaches full descriptions
 * from the sidecar DB, and attaches Qwen3 classifications from the local router DB.
 * All three databases are opened strictly in read-only mode.
 */
export function loadOdysseusEvaluationInventory(paths: {
  canonicalDbPath: string;
  sidecarDbPath: string;
  qwenRouterDbPath: string;
  repo?: string;
}): EnrichedEvaluationItem[] {
  const repo = paths.repo || "odysseus-dev/odysseus";

  const canonicalDb = new Database(paths.canonicalDbPath, { readonly: true });
  const sidecarDb = new Database(paths.sidecarDbPath, { readonly: true });
  const routerDb = new Database(paths.qwenRouterDbPath, { readonly: true });

  try {
    const canonicalRows = canonicalDb
      .prepare(`
        SELECT number, type, repo, title, body_snippet, created_at, updated_at, metadata_json
        FROM items
        WHERE repo = ? AND type IN ('pr', 'issue')
          AND json_extract(metadata_json, '$.state') = 'open'
        ORDER BY updated_at DESC, number DESC
      `)
      .all(repo) as Array<{
      number: number;
      type: "pr" | "issue";
      repo: string;
      title: string;
      body_snippet: string;
      created_at: string;
      updated_at: string;
      metadata_json: string;
    }>;

    const sidecarRows = sidecarDb
      .prepare(`
        SELECT item_type, number, body, body_len
        FROM item_descriptions
        WHERE repo = ?
      `)
      .all(repo) as Array<{
      item_type: "pr" | "issue";
      number: number;
      body: string;
      body_len: number;
    }>;

    const sidecarMap = new Map<string, { body: string; bodyLen: number }>();
    for (const r of sidecarRows) {
      sidecarMap.set(`${r.item_type}:${r.number}`, { body: r.body, bodyLen: r.body_len });
    }

    const qwenRows = routerDb
      .prepare(`
        SELECT *
        FROM classifications
        WHERE repo = ?
      `)
      .all(repo) as any[];

    const qwenMap = new Map<string, QwenClassificationRow>();
    for (const r of qwenRows) {
      qwenMap.set(`${r.item_type}:${r.item_number}`, {
        repo: r.repo,
        itemType: r.item_type,
        itemNumber: Number(r.item_number),
        model: r.model,
        sourceHash: r.source_hash,
        category: r.category,
        priority: r.priority,
        complexity: r.complexity,
        confidence: Number(r.confidence),
        needsDeepReview: Boolean(r.needs_deep_review),
        riskFlags: JSON.parse(r.risk_flags_json || "[]"),
        reason: r.reason,
        escalate: Boolean(r.escalate),
        escalationReason: r.escalation_reason || "",
        uncertaintyFlags: (r.uncertainty_flags || "").split(";").filter(Boolean),
        fullBodyLen: Number(r.full_body_len || 0),
        isInputTruncated: Boolean(r.is_input_truncated),
        promptTokens: Number(r.prompt_tokens || 0),
        outputTokens: Number(r.output_tokens || 0),
        elapsedSeconds: Number(r.elapsed_seconds || 0),
        classifiedAt: r.classified_at,
      });
    }

    return canonicalRows.map((row) => {
      const meta = JSON.parse(row.metadata_json || "{}");
      const key = `${row.type}:${row.number}`;
      const sidecar = sidecarMap.get(key);
      const fullBody = sidecar ? sidecar.body : row.body_snippet;
      const fullBodyLength = sidecar ? sidecar.bodyLen : fullBody.length;

      const prItem: PRItem = {
        number: Number(row.number),
        type: row.type,
        repo: row.repo,
        title: row.title,
        body: fullBody,
        state: meta.state || "open",
        author: meta.author || "unknown",
        authorIsBot: meta.authorIsBot,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        closedAt: meta.closedAt,
        labels: Array.isArray(meta.labels) ? meta.labels : [],
        ciStatus: meta.ciStatus,
        reviewCount: meta.reviewCount,
        additions: meta.additions,
        deletions: meta.deletions,
        changedFiles: meta.changedFiles,
        hasTests: meta.hasTests,
        nodeId: meta.nodeId,
        headRefOid: meta.headRefOid,
        closesIssues: meta.closesIssues,
      };

      return {
        prItem,
        fullBodyLength,
        qwen: qwenMap.get(key),
      };
    });
  } finally {
    canonicalDb.close();
    sidecarDb.close();
    routerDb.close();
  }
}

/**
 * Selects a deterministic, stratified pilot sample (default 160 items, within 100-200)
 * covering security-sensitive, high-risk, uncertain/truncated/repaired, and local-only items.
 */
export function selectStratifiedPilotSample(
  inventory: EnrichedEvaluationItem[],
  targetSize = 160,
): EnrichedEvaluationItem[] {
  const selected = new Map<string, EnrichedEvaluationItem>();
  const keyOf = (item: EnrichedEvaluationItem) => `${item.prItem.type}:${item.prItem.number}`;

  const addItems = (candidates: EnrichedEvaluationItem[], limit: number, stratum: string) => {
    let added = 0;
    for (const c of candidates) {
      if (added >= limit) break;
      const k = keyOf(c);
      if (!selected.has(k)) {
        selected.set(k, { ...c, stratum });
        added++;
      }
    }
  };

  // 1. Always include the 3 repaired local JSON failure items (#6745, #605, #3604)
  const repaired = inventory.filter((x) => [6745, 605, 3604].includes(x.prItem.number));
  addItems(repaired, 10, "repaired_json_failure");

  // 2. Security & data-loss sensitive items (Qwen category='security' or security/data_loss/privacy risk flag or safety gate)
  const securityAndDataLoss = inventory.filter((x) => {
    const q = x.qwen;
    if (!q) return false;
    return (
      q.category === "security" ||
      q.riskFlags.some((f) => ["security", "data_loss", "privacy", "permissions"].includes(f)) ||
      q.escalationReason.includes("safety_gate:")
    );
  });
  addItems(securityAndDataLoss, Math.round(targetSize * 0.28), "security_and_data_loss");

  // 3. Uncertain, low-confidence, or input-truncated items
  const uncertainOrTruncated = inventory.filter((x) => {
    const q = x.qwen;
    if (!q) return false;
    return (
      q.confidence < 0.8 ||
      q.isInputTruncated ||
      q.uncertaintyFlags.length > 0 ||
      q.complexity === "unknown" ||
      q.priority === "unknown"
    );
  });
  addItems(uncertainOrTruncated, Math.round(targetSize * 0.22), "uncertain_or_truncated");

  // 4. High-risk / high-priority / complex escalated items (split between PRs and Issues)
  const highRiskPRs = inventory.filter(
    (x) =>
      x.prItem.type === "pr" && x.qwen?.escalate && (x.qwen.priority === "high" || x.qwen.complexity === "complex"),
  );
  const highRiskIssues = inventory.filter(
    (x) =>
      x.prItem.type === "issue" &&
      x.qwen?.escalate &&
      (x.qwen.priority === "critical" || x.qwen.priority === "high" || x.qwen.complexity === "complex"),
  );
  addItems(highRiskPRs, Math.round(targetSize * 0.12), "escalated_high_risk_pr");
  addItems(highRiskIssues, Math.round(targetSize * 0.13), "escalated_high_risk_issue");

  // 5. Local-only items across PRs and Issues (tests, documentation, routine bugs, features, refactors)
  const localOnlyPRs = inventory.filter((x) => x.prItem.type === "pr" && x.qwen && !x.qwen.escalate);
  const localOnlyIssues = inventory.filter((x) => x.prItem.type === "issue" && x.qwen && !x.qwen.escalate);
  addItems(localOnlyPRs, Math.round(targetSize * 0.12), "local_only_pr");
  addItems(localOnlyIssues, targetSize - selected.size, "local_only_issue");

  // Fill any remaining slots if needed
  if (selected.size < targetSize) {
    addItems(inventory, targetSize - selected.size, "general_fill");
  }

  return Array.from(selected.values()).slice(0, targetSize);
}

export interface BatchEvaluationResult {
  records: JevFirstDecisionRecord[];
  newlyEvaluated: number;
  cachedReused: number;
  failed: Array<{ type: string; number: number; error: string }>;
  wallClockMs: number;
}

/**
 * Evaluates a batch of items with Jev-First v2 using bounded concurrency
 * and durable SQLite checkpointing.
 */
export async function runJevEvaluationBatch(
  items: EnrichedEvaluationItem[],
  provider: DecisionProvider,
  store: JevDecisionStore,
  options: {
    concurrency?: number;
    model?: string;
    maxBodyLength?: number;
    onProgress?: (done: number, total: number, cached: number) => void;
  } = {},
): Promise<BatchEvaluationResult> {
  const concurrency = Math.max(1, Math.min(10, options.concurrency ?? 5));
  const model = options.model || DEFAULT_JEV_MODEL;
  const maxBodyLength = options.maxBodyLength ?? 14000;
  const rubricHash = computeRubricHash(JEV_FIRST_QUESTIONS, JEV_FIRST_SCHEMA_VERSION);

  const records: JevFirstDecisionRecord[] = new Array(items.length);
  const failed: Array<{ type: string; number: number; error: string }> = [];
  let newlyEvaluated = 0;
  let cachedReused = 0;
  let completedCount = 0;
  let nextIndex = 0;

  const startWall = performance.now();

  const worker = async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) break;
      const entry = items[idx];
      const { prItem, fullBodyLength } = entry;

      const { state } = prepareJevFirstState(prItem, { maxBodyLength, fullBodyLength });
      const inputHash = computeStateHash(state);
      const expectedIdentity = computeDecisionIdentity({
        inputHash,
        rubricHash,
        model,
        schemaVersion: JEV_FIRST_SCHEMA_VERSION,
      });

      if (store.hasFreshDecision(prItem.repo, prItem.type, prItem.number, expectedIdentity, model)) {
        const cached = store.getDecision(prItem.repo, prItem.type, prItem.number, model);
        if (cached) {
          records[idx] = cached;
          cachedReused++;
          completedCount++;
          options.onProgress?.(completedCount, items.length, cachedReused);
          continue;
        }
      }

      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const rec = await evaluateJevFirstItem(prItem, provider, {
            model,
            maxBodyLength,
            fullBodyLength,
            timeoutMs: 25000,
          });
          store.upsertDecision(rec);
          records[idx] = rec;
          newlyEvaluated++;
          lastErr = undefined;
          break;
        } catch (err: any) {
          lastErr = err;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
      }

      if (lastErr) {
        failed.push({
          type: prItem.type,
          number: prItem.number,
          error: (lastErr as any)?.message || String(lastErr),
        });
      }

      completedCount++;
      options.onProgress?.(completedCount, items.length, cachedReused);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  return {
    records: records.filter(Boolean),
    newlyEvaluated,
    cachedReused,
    failed,
    wallClockMs: Math.round(performance.now() - startWall),
  };
}

export interface ComparisonSummaryMetrics {
  totalCompared: number;
  categoryExactMatchCount: number;
  categoryExactMatchRate: number;
  priorityExactMatchCount: number;
  priorityExactMatchRate: number;
  priorityWithinOneTierCount: number;
  priorityWithinOneTierRate: number;
  complexityExactMatchCount: number;
  complexityExactMatchRate: number;
  routingAgreementCount: number;
  routingAgreementRate: number;
  routingConfusion: {
    bothEscalate: number;
    bothLocalOnly: number;
    jevOnlyEscalate: number;
    qwenOnlyEscalate: number;
  };
  jevEscalationRate: number;
  qwenEscalationRate: number;
  safetyAnalysis: {
    deterministicGateItems: number;
    deterministicGateJevEscalatedCount: number;
    qwenSecurityOrDataLossCount: number;
    jevRawModelCaughtCount: number;
    jevSystemPostGateEscalatedCount: number;
    unmitigatedHighRiskFalseNegatives: Array<{
      type: string;
      number: number;
      title: string;
      qwenCategory: string;
      qwenRisks: string[];
      jevCategory: string;
      jevSafetyProb: number | null;
    }>;
  };
  performance: {
    jevMeanLatencyMs: number;
    jevMedianLatencyMs: number;
    jevP95LatencyMs: number;
    qwenMeanLatencyMs: number;
    speedupFactor: number;
    jevTotalInputTokens: number;
    jevTotalOutputTokens: number;
    jevAvgInputTokens: number;
    jevAvgOutputTokens: number;
    jevTotalCostUsd: number;
    jevCostPer1000ItemsUsd: number;
    qwenTotalPromptTokens: number;
    qwenTotalOutputTokens: number;
  };
  calibrationBuckets: Array<{
    bucket: string;
    itemCount: number;
    categoryAgreementRate: number;
    routingAgreementRate: number;
    escalationRate: number;
  }>;
  categoryConfusion: Record<string, Record<string, number>>;
  notableDisagreements: Array<{
    type: string;
    number: number;
    title: string;
    stratum?: string;
    qwenCategory: string;
    jevCategory: string;
    qwenPriority: string;
    jevPriority: string;
    qwenEscalate: boolean;
    jevEscalate: boolean;
    qwenReason: string;
    jevEscalationReasons: string[];
    jevSafetyProb: number | null;
    jevDeepReviewProb: number | null;
  }>;
}

const PRIORITY_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Compares Jev-First v2 decisions against local Qwen3 classifications across all
 * required dimensions, latency, token usage, cost, safety false negatives, and calibration.
 */
export function compareJevAgainstQwen(
  items: EnrichedEvaluationItem[],
  jevRecords: JevFirstDecisionRecord[],
): ComparisonSummaryMetrics {
  const jevByKey = new Map<string, JevFirstDecisionRecord>();
  for (const r of jevRecords) {
    jevByKey.set(`${r.item.type}:${r.item.number}`, r);
  }

  let totalCompared = 0;
  let categoryExactMatchCount = 0;
  let priorityExactMatchCount = 0;
  let priorityWithinOneTierCount = 0;
  let complexityExactMatchCount = 0;
  let routingAgreementCount = 0;

  let bothEscalate = 0;
  let bothLocalOnly = 0;
  let jevOnlyEscalate = 0;
  let qwenOnlyEscalate = 0;

  let deterministicGateItems = 0;
  let deterministicGateJevEscalatedCount = 0;
  let qwenSecurityOrDataLossCount = 0;
  let jevRawModelCaughtCount = 0;
  let jevSystemPostGateEscalatedCount = 0;

  const unmitigatedHighRiskFalseNegatives: ComparisonSummaryMetrics["safetyAnalysis"]["unmitigatedHighRiskFalseNegatives"] =
    [];
  const notableDisagreements: ComparisonSummaryMetrics["notableDisagreements"] = [];
  const categoryConfusion: Record<string, Record<string, number>> = {};

  const jevLatencies: number[] = [];
  let qwenTotalLatencyMs = 0;
  let jevTotalInputTokens = 0;
  let jevTotalOutputTokens = 0;
  let jevTotalCostUsd = 0;
  let qwenTotalPromptTokens = 0;
  let qwenTotalOutputTokens = 0;

  const bucketDefs = [
    { label: "0.00 - 0.59 (Low concentration)", min: 0, max: 0.6 },
    { label: "0.60 - 0.74 (Moderate concentration)", min: 0.6, max: 0.75 },
    { label: "0.75 - 0.89 (High concentration)", min: 0.75, max: 0.9 },
    { label: "0.90 - 1.00 (Very high concentration)", min: 0.9, max: 1.01 },
  ];
  const bucketStats = bucketDefs.map((b) => ({
    bucket: b.label,
    min: b.min,
    max: b.max,
    count: 0,
    catMatch: 0,
    routeMatch: 0,
    escalated: 0,
  }));

  for (const entry of items) {
    const qwen = entry.qwen;
    const jev = jevByKey.get(`${entry.prItem.type}:${entry.prItem.number}`);
    if (!qwen || !jev) continue;

    totalCompared++;

    const qCat = qwen.category;
    const jCat = jev.classification.category;
    if (!categoryConfusion[qCat]) categoryConfusion[qCat] = {};
    categoryConfusion[qCat][jCat] = (categoryConfusion[qCat][jCat] || 0) + 1;

    const isCatMatch = qCat === jCat;
    if (isCatMatch) categoryExactMatchCount++;

    const qPrio = qwen.priority;
    const jPrio = jev.derived.priorityTier;
    if (qPrio === jPrio) priorityExactMatchCount++;
    if (
      PRIORITY_RANK[qPrio] !== undefined &&
      PRIORITY_RANK[jPrio] !== undefined &&
      Math.abs(PRIORITY_RANK[qPrio] - PRIORITY_RANK[jPrio]) <= 1
    ) {
      priorityWithinOneTierCount++;
    }

    if (qwen.complexity === jev.derived.complexityTier) {
      complexityExactMatchCount++;
    }

    const qEsc = qwen.escalate;
    const jEsc = jev.routing.escalateToDeepReview;
    const isRouteMatch = qEsc === jEsc;
    if (isRouteMatch) routingAgreementCount++;

    if (qEsc && jEsc) bothEscalate++;
    else if (!qEsc && !jEsc) bothLocalOnly++;
    else if (!qEsc && jEsc) jevOnlyEscalate++;
    else if (qEsc && !jEsc) qwenOnlyEscalate++;

    if (jev.routing.deterministicSafetyGates.length > 0) {
      deterministicGateItems++;
      if (jEsc) deterministicGateJevEscalatedCount++;
    }

    const isQwenSecOrDataLoss =
      qwen.category === "security" ||
      qwen.riskFlags.some((f) => ["security", "data_loss", "privacy", "permissions"].includes(f));

    if (isQwenSecOrDataLoss) {
      qwenSecurityOrDataLossCount++;
      const rawCaught =
        jev.classification.category === "security" ||
        (jev.scores.maxSafetyRiskProb ?? 0) >= 0.3 ||
        (jev.scores.needsDeepReviewProb ?? 0) >= 0.5;
      if (rawCaught) jevRawModelCaughtCount++;
      if (jEsc) {
        jevSystemPostGateEscalatedCount++;
      } else {
        unmitigatedHighRiskFalseNegatives.push({
          type: entry.prItem.type,
          number: entry.prItem.number,
          title: entry.prItem.title,
          qwenCategory: qwen.category,
          qwenRisks: qwen.riskFlags,
          jevCategory: jev.classification.category,
          jevSafetyProb: jev.scores.maxSafetyRiskProb,
        });
      }
    }

    if (!isRouteMatch || !isCatMatch) {
      notableDisagreements.push({
        type: entry.prItem.type,
        number: entry.prItem.number,
        title: entry.prItem.title,
        stratum: entry.stratum,
        qwenCategory: qCat,
        jevCategory: jCat,
        qwenPriority: qPrio,
        jevPriority: jPrio,
        qwenEscalate: qEsc,
        jevEscalate: jEsc,
        qwenReason: qwen.reason,
        jevEscalationReasons: jev.routing.escalationReasons,
        jevSafetyProb: jev.scores.maxSafetyRiskProb,
        jevDeepReviewProb: jev.scores.needsDeepReviewProb,
      });
    }

    if (typeof jev.provenance.latencyMs === "number") {
      jevLatencies.push(jev.provenance.latencyMs);
    }
    qwenTotalLatencyMs += qwen.elapsedSeconds * 1000;
    jevTotalInputTokens += jev.provenance.usage?.inputTokens ?? 0;
    jevTotalOutputTokens += jev.provenance.usage?.outputTokens ?? 0;
    jevTotalCostUsd += jev.provenance.estimatedCostUsd;
    qwenTotalPromptTokens += qwen.promptTokens;
    qwenTotalOutputTokens += qwen.outputTokens;

    const conf = jev.classification.categoryConfidence ?? 0.5;
    for (const b of bucketStats) {
      if (conf >= b.min && conf < b.max) {
        b.count++;
        if (isCatMatch) b.catMatch++;
        if (isRouteMatch) b.routeMatch++;
        if (jEsc) b.escalated++;
        break;
      }
    }
  }

  jevLatencies.sort((a, b) => a - b);
  const jevMeanLatencyMs = jevLatencies.length > 0 ? jevLatencies.reduce((s, v) => s + v, 0) / jevLatencies.length : 0;
  const jevMedianLatencyMs = jevLatencies.length > 0 ? jevLatencies[Math.floor(jevLatencies.length * 0.5)] : 0;
  const jevP95LatencyMs = jevLatencies.length > 0 ? jevLatencies[Math.floor(jevLatencies.length * 0.95)] : 0;
  const qwenMeanLatencyMs = totalCompared > 0 ? qwenTotalLatencyMs / totalCompared : 0;

  return {
    totalCompared,
    categoryExactMatchCount,
    categoryExactMatchRate: totalCompared > 0 ? categoryExactMatchCount / totalCompared : 0,
    priorityExactMatchCount,
    priorityExactMatchRate: totalCompared > 0 ? priorityExactMatchCount / totalCompared : 0,
    priorityWithinOneTierCount,
    priorityWithinOneTierRate: totalCompared > 0 ? priorityWithinOneTierCount / totalCompared : 0,
    complexityExactMatchCount,
    complexityExactMatchRate: totalCompared > 0 ? complexityExactMatchCount / totalCompared : 0,
    routingAgreementCount,
    routingAgreementRate: totalCompared > 0 ? routingAgreementCount / totalCompared : 0,
    routingConfusion: {
      bothEscalate,
      bothLocalOnly,
      jevOnlyEscalate,
      qwenOnlyEscalate,
    },
    jevEscalationRate: totalCompared > 0 ? (bothEscalate + jevOnlyEscalate) / totalCompared : 0,
    qwenEscalationRate: totalCompared > 0 ? (bothEscalate + qwenOnlyEscalate) / totalCompared : 0,
    safetyAnalysis: {
      deterministicGateItems,
      deterministicGateJevEscalatedCount,
      qwenSecurityOrDataLossCount,
      jevRawModelCaughtCount,
      jevSystemPostGateEscalatedCount,
      unmitigatedHighRiskFalseNegatives,
    },
    performance: {
      jevMeanLatencyMs: Math.round(jevMeanLatencyMs),
      jevMedianLatencyMs: Math.round(jevMedianLatencyMs),
      jevP95LatencyMs: Math.round(jevP95LatencyMs),
      qwenMeanLatencyMs: Math.round(qwenMeanLatencyMs),
      speedupFactor: jevMeanLatencyMs > 0 ? Number((qwenMeanLatencyMs / jevMeanLatencyMs).toFixed(2)) : 0,
      jevTotalInputTokens,
      jevTotalOutputTokens,
      jevAvgInputTokens: totalCompared > 0 ? Number((jevTotalInputTokens / totalCompared).toFixed(1)) : 0,
      jevAvgOutputTokens: totalCompared > 0 ? Number((jevTotalOutputTokens / totalCompared).toFixed(1)) : 0,
      jevTotalCostUsd: Number(jevTotalCostUsd.toFixed(6)),
      jevCostPer1000ItemsUsd: totalCompared > 0 ? Number(((jevTotalCostUsd / totalCompared) * 1000).toFixed(4)) : 0,
      qwenTotalPromptTokens,
      qwenTotalOutputTokens,
    },
    calibrationBuckets: bucketStats.map((b) => ({
      bucket: b.bucket,
      itemCount: b.count,
      categoryAgreementRate: b.count > 0 ? Number((b.catMatch / b.count).toFixed(3)) : 0,
      routingAgreementRate: b.count > 0 ? Number((b.routeMatch / b.count).toFixed(3)) : 0,
      escalationRate: b.count > 0 ? Number((b.escalated / b.count).toFixed(3)) : 0,
    })),
    categoryConfusion,
    notableDisagreements,
  };
}
