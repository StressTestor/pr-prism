import type { PRItem, ScoredPR, ScoreSignals } from "./types.js";
import type { PrismConfig } from "./config.js";
import type { GitHubClient } from "./github.js";

interface ScorerContext {
  authorMergeCounts: Map<string, number>;
}

function normalizeDescriptionQuality(body: string): number {
  if (!body) return 0;
  const len = body.length;
  if (len < 50) return 0.1;
  if (len < 200) return 0.3 + (len - 50) / 150 * 0.3;
  if (len < 1000) return 0.6 + (len - 200) / 800 * 0.3;
  return 0.9 + Math.min(0.1, (len - 1000) / 5000 * 0.1);
}

function normalizeDiffSize(additions: number, deletions: number): number {
  const total = additions + deletions;
  if (total <= 50) return 1.0;
  if (total <= 200) return 0.8;
  if (total <= 500) return 0.6;
  if (total <= 1000) return 0.4;
  if (total <= 5000) return 0.2;
  return 0.1;
}

function normalizeAuthorHistory(mergeCount: number): number {
  if (mergeCount === 0) return 0.1;
  if (mergeCount <= 5) return 0.2 + mergeCount * 0.04;
  if (mergeCount <= 20) return 0.4 + (mergeCount - 5) * 0.02;
  return Math.min(1.0, 0.7 + (mergeCount - 20) * 0.005);
}

export async function buildScorerContext(
  items: PRItem[],
  github: GitHubClient
): Promise<ScorerContext> {
  const authorMergeCounts = new Map<string, number>();

  const authorFreq = new Map<string, number>();
  for (const item of items) {
    if (item.author && item.author !== "unknown") {
      authorFreq.set(item.author, (authorFreq.get(item.author) || 0) + 1);
    }
  }

  const topAuthors = [...authorFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([author]) => author);

  for (const author of topAuthors) {
    const count = await github.getAuthorMergeCountGraphQL(author);
    authorMergeCounts.set(author, count);
    // 300ms throttle — respects GitHub's ~30 req/min secondary rate limit on search
    await new Promise(r => setTimeout(r, 300));
  }

  return { authorMergeCounts };
}

export function scorePR(
  item: PRItem,
  config: PrismConfig,
  context: ScorerContext
): ScoredPR {
  const weights = config.scoring.weights;
  const authorMerges = context.authorMergeCounts.get(item.author) || 0;

  const hasDiffStats = item.additions != null && item.deletions != null;

  const signals: ScoreSignals = {
    hasTests: item.hasTests === true ? 1.0 : item.hasTests === false ? 0.0 : 0.5,
    ciPassing: item.ciStatus === "success" ? 1 : item.ciStatus === "failure" ? 0 : 0.5,
    diffSize: hasDiffStats ? normalizeDiffSize(item.additions!, item.deletions!) : -1,
    authorHistory: normalizeAuthorHistory(authorMerges),
    descriptionQuality: normalizeDescriptionQuality(item.body),
    reviewApprovals: Math.min(1.0, (item.reviewCount || 0) / 3),
    recency: Math.pow(0.5, (Date.now() - new Date(item.updatedAt).getTime()) / (1000 * 60 * 60 * 24 * 30)),
  };

  let effectiveWeights = { ...weights };
  if (!hasDiffStats) {
    const redistributed = weights.diff_size_penalty;
    const otherTotal = 1 - redistributed;
    effectiveWeights = {
      has_tests: weights.has_tests / otherTotal,
      ci_passing: weights.ci_passing / otherTotal,
      diff_size_penalty: 0,
      author_history: weights.author_history / otherTotal,
      description_quality: weights.description_quality / otherTotal,
      review_approvals: weights.review_approvals / otherTotal,
    };
  }

  const score =
    signals.hasTests * effectiveWeights.has_tests +
    signals.ciPassing * effectiveWeights.ci_passing +
    (signals.diffSize >= 0 ? signals.diffSize : 0) * effectiveWeights.diff_size_penalty +
    signals.authorHistory * effectiveWeights.author_history +
    signals.descriptionQuality * effectiveWeights.description_quality +
    signals.reviewApprovals * effectiveWeights.review_approvals +
    signals.recency * 0.05; // small recency bonus

  return { ...item, score, signals };
}

export function rankPRs(
  items: PRItem[],
  config: PrismConfig,
  context: ScorerContext
): ScoredPR[] {
  return items
    .map(item => scorePR(item, config, context))
    .sort((a, b) => b.score - a.score);
}
