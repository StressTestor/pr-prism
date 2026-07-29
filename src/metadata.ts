import type { PRItem } from "./types.js";

/**
 * Single source for an item's stored metadata: used for new-item upserts, the
 * unchanged-item refresh, and the App path's backlog scan, so drifting fields
 * cannot diverge between them.
 *
 * Its own module rather than living beside the CLI pipeline, because the
 * server imports it and should not pull a spinner, a GitHub client and an
 * embedder factory along with it.
 */
export function itemMetadata(item: PRItem): Record<string, unknown> {
  return {
    author: item.author,
    authorIsBot: item.authorIsBot,
    state: item.state,
    closedAt: item.closedAt,
    labels: item.labels,
    additions: item.additions,
    deletions: item.deletions,
    changedFiles: item.changedFiles,
    ciStatus: item.ciStatus,
    reviewCount: item.reviewCount,
    hasTests: item.hasTests,
    bodyLength: item.body.length,
    nodeId: item.nodeId,
    headRefOid: item.headRefOid,
    closesIssues: item.closesIssues,
  };
}
