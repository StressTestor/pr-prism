/**
 * Maintainer Workbench — Review Adapter
 *
 * Extracts deep review findings and recommendations from VectorStore,
 * computing review freshness against the PR's latest update timestamp.
 */

import type { DurableReviewQueue } from "../../review-queue.js";
import type { VectorStore } from "../../store.js";

/**
 * Normalized review outcome for maintainer workbench presentation.
 */
export interface MaintainerReviewResult {
  /** Whether a review record exists for the given item. */
  hasReview: boolean;
  /** Normalized review recommendation or null if no review exists. */
  recommendation: "merge" | "revise" | "close" | "needs_human_review" | null;
  /** Calibrated review confidence score (0..1) or null. */
  confidence: number | null;
  /** High-level executive summary of review findings or null. */
  summary: string | null;
  /** Number of specific concerns/findings raised by the review. */
  findingsCount: number;
}

/**
 * Retrieves the review result for a pull request from the VectorStore,
 * falling back to DurableReviewQueue checkpoints if provided.
 *
 * @param store The VectorStore instance
 * @param repo Full repository name (e.g. "owner/repo")
 * @param number Pull request number
 * @param queue Optional DurableReviewQueue instance
 * @returns MaintainerReviewResult structure
 */
export function getReviewResult(
  store: VectorStore,
  repo: string,
  number: number,
  queue?: DurableReviewQueue,
): MaintainerReviewResult {
  const review = store.getReview(repo, number);
  if (review) {
    let recommendation: "merge" | "revise" | "close" | "needs_human_review" | null = null;
    if (
      review.recommendation === "merge" ||
      review.recommendation === "revise" ||
      review.recommendation === "close" ||
      review.recommendation === "needs_human_review"
    ) {
      recommendation = review.recommendation;
    } else if (review.recommendation) {
      recommendation = "needs_human_review";
    }

    const findingsCount = Array.isArray(review.concerns) ? review.concerns.length : 0;

    return {
      hasReview: true,
      recommendation,
      confidence: typeof review.confidence === "number" ? review.confidence : null,
      summary: review.summary || null,
      findingsCount,
    };
  }

  // Fallback to queue checkpoints if available
  if (queue) {
    try {
      const checkpoint = queue.getLatestValidCheckpoint(repo, number);
      if (checkpoint?.result_json) {
        const parsed = JSON.parse(checkpoint.result_json);
        let recommendation: "merge" | "revise" | "close" | "needs_human_review" | null = null;
        if (
          parsed.recommendation === "merge" ||
          parsed.recommendation === "revise" ||
          parsed.recommendation === "close" ||
          parsed.recommendation === "needs_human_review"
        ) {
          recommendation = parsed.recommendation;
        } else if (parsed.issueAction) {
          recommendation = parsed.issueAction === "close_duplicate" ? "close" : "needs_human_review";
        } else if (parsed.recommendation) {
          recommendation = "needs_human_review";
        }

        const findings = Array.isArray(parsed.findings)
          ? parsed.findings
          : Array.isArray(parsed.concerns)
            ? parsed.concerns
            : [];

        return {
          hasReview: true,
          recommendation,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
          summary: parsed.summary || null,
          findingsCount: findings.length,
        };
      }
    } catch {
      // ignore parse errors
    }
  }

  return {
    hasReview: false,
    recommendation: null,
    confidence: null,
    summary: null,
    findingsCount: 0,
  };
}

/**
 * Computes whether a stored review is fresh or stale relative to the PR's last updated timestamp.
 *
 * @param reviewedAt ISO-8601 timestamp when the review was conducted, or undefined
 * @param itemUpdatedAt ISO-8601 timestamp of the item's last modification
 * @returns "fresh" if review occurred at or after last update, "stale" if item was updated afterwards, or "none"
 */
export function computeReviewFreshness(
  reviewedAt: string | undefined,
  itemUpdatedAt: string,
): "fresh" | "stale" | "none" {
  if (!reviewedAt) return "none";
  const revTime = new Date(reviewedAt).getTime();
  const updTime = new Date(itemUpdatedAt).getTime();
  if (Number.isNaN(revTime) || Number.isNaN(updTime)) return "none";
  return revTime >= updTime ? "fresh" : "stale";
}
