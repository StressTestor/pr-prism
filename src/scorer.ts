import type { PRItem, ScoredPR, ScoreSignals } from "./types.js";
import type { PrismConfig } from "./config.js";
import type { GitHubClient } from "./github.js";

interface ScorerContext {
  authorMergeCounts: Map<string, number>;
}

function normalizeDescriptionQuality(body: string): number {
  if (!body) return 0;
  const len = body.length;
  // 0-50 chars: poor, 50-200: okay, 200-1000: good, 1000+: great
  if (len < 50) return 0.1;
  if (len < 200) return 0.3 + (len - 50) / 150 * 0.3;
  if (len < 1000) return 0.6 + (len - 200) / 800 * 0.3;
  return 0.9 + Math.min(0.1, (len - 1000) / 5000 * 0.1);
}

function normalizeDiffSize(additions: number, deletions: number): number {
  const total = additions + deletions;
  // Smaller diffs score higher. 1-50 lines = 1.0, scales down to 0.1 at 5000+
  if (total <= 50) return 1.0;
  if (total <= 200) return 0.8;
  if (total <= 500) return 0.6;
  if (total <= 1000) return 0.4;
  if (total <= 5000) return 0.2;
  return 0.1;
}

function normalizeAuthorHistory(mergeCount: number): number {
  // 0 merges: 0.1, 1-5: 0.4, 5-20: 0.7, 20+: 1.0
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

  // Count how many PRs each author has in the dataset
  const authorFreq = new Map<string, number>();
  for (const item of items) {
    if (item.author && item.author !== "unknown") {
      authorFreq.set(item.author, (authorFreq.get(item.author) || 0) + 1);
    }
  }

  // Only look up the top 50 most active authors to avoid hammering search API
  const topAuthors = [...authorFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([author]) => author);

  for (const author of topAuthors) {
    const count = await github.getAuthorMergeCount(author);
    authorMergeCounts.set(author, count);
    // Respect GitHub's secondary rate limit (30 req/min for search)
    await new Promise(r => setTimeout(r, 2100));
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
    hasTests: 0.5, // Would need diff analysis to determine
    ciPassing: item.ciStatus === "success" ? 1 : item.ciStatus === "failure" ? 0 : 0.5,
    diffSize: hasDiffStats ? normalizeDiffSize(item.additions!, item.deletions!) : -1,
    authorHistory: normalizeAuthorHistory(authorMerges),
    descriptionQuality: normalizeDescriptionQuality(item.body),
    reviewApprovals: Math.min(1.0, (item.reviewCount || 0) / 3),
    recency: Math.pow(0.5, (Date.now() - new Date(item.updatedAt).getTime()) / (1000 * 60 * 60 * 24 * 30)),
  };

  // When diff stats aren't available, redistribute that weight proportionally
  let effectiveWeights = { ...weights };
  if (!hasDiffStats) {
    const redistributed = weights.diff_size_penalty;
    const otherTotal = 1 - redistributed;
    effectiveWeights = {
      has_tests: weights.has_tests / otherTotal * (1),
      ci_passing: weights.ci_passing / otherTotal * (1),
      diff_size_penalty: 0,
      author_history: weights.author_history / otherTotal * (1),
      description_quality: weights.description_quality / otherTotal * (1),
      review_approvals: weights.review_approvals / otherTotal * (1),
    };
  }

  const score =
    signals.hasTests * effectiveWeights.has_tests +
    signals.ciPassing * effectiveWeights.ci_passing +
    (signals.diffSize >= 0 ? signals.diffSize : 0) * effectiveWeights.diff_size_penalty +
    signals.authorHistory * effectiveWeights.author_history +
    signals.descriptionQuality * effectiveWeights.description_quality +
    signals.reviewApprovals * effectiveWeights.review_approvals;

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
