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
  const authors = [...new Set(items.map(i => i.author))];
  const authorMergeCounts = new Map<string, number>();

  // Batch fetch author merge counts (rate-limit-aware)
  for (const author of authors) {
    const count = await github.getAuthorMergeCount(author);
    authorMergeCounts.set(author, count);
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

  const signals: ScoreSignals = {
    hasTests: 0.5, // Default unknown — would need diff analysis to determine
    ciPassing: item.ciStatus === "success" ? 1 : item.ciStatus === "failure" ? 0 : 0.5,
    diffSize: normalizeDiffSize(item.additions || 0, item.deletions || 0),
    authorHistory: normalizeAuthorHistory(authorMerges),
    descriptionQuality: normalizeDescriptionQuality(item.body),
    reviewApprovals: Math.min(1.0, (item.reviewCount || 0) / 3),
    recency: Math.pow(0.5, (Date.now() - new Date(item.updatedAt).getTime()) / (1000 * 60 * 60 * 24 * 30)),
  };

  const score =
    signals.hasTests * weights.has_tests +
    signals.ciPassing * weights.ci_passing +
    signals.diffSize * weights.diff_size_penalty +
    signals.authorHistory * weights.author_history +
    signals.descriptionQuality * weights.description_quality +
    signals.reviewApprovals * weights.review_approvals;

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
