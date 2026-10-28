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
/**
 * The stored-metadata shape. Named so a partial writer (the webhook path, which
 * can only observe some fields) is checked against it by the compiler instead
 * of asserting the key names at runtime.
 */
export type MetadataProvenance = "graphql" | "rest" | "mixed";

export type ItemMetadata = {
  author: string;
  authorIsBot: boolean | undefined;
  state: string;
  closedAt: string | undefined;
  labels: string[];
  additions: number | undefined;
  deletions: number | undefined;
  changedFiles: number | undefined;
  ciStatus: PRItem["ciStatus"];
  reviewCount: number | undefined;
  hasTests: boolean | undefined;
  bodyLength: number;
  nodeId: string | undefined;
  headRefOid: string | undefined;
  closesIssues: number[] | undefined;
  provenance?: MetadataProvenance;
};

export function itemMetadata(item: PRItem, source?: "graphql" | "rest"): ItemMetadata {
  const isGraphQL =
    source === "graphql" ||
    (source === undefined &&
      (item.ciStatus !== undefined ||
        item.reviewCount !== undefined ||
        item.hasTests !== undefined ||
        item.closesIssues !== undefined));

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
    bodyLength: item.body ? item.body.length : 0,
    nodeId: item.nodeId,
    headRefOid: item.headRefOid,
    closesIssues: item.closesIssues,
    provenance: isGraphQL ? "graphql" : "rest",
  };
}

/**
 * Merges fresh item metadata with existing stored metadata, ensuring that
 * high-fidelity fields (ciStatus, hasTests, reviewCount, additions, deletions,
 * changedFiles, closesIssues, nodeId, headRefOid) are never silently erased
 * when updating from a lower-fidelity source such as REST.
 */
export function preserveItemMetadata(
  fresh: ItemMetadata,
  existing?: Record<string, unknown> | ItemMetadata,
): ItemMetadata {
  if (!existing) {
    return fresh;
  }

  const ciStatus = fresh.ciStatus !== undefined ? fresh.ciStatus : (existing.ciStatus as PRItem["ciStatus"]);
  const reviewCount =
    fresh.reviewCount !== undefined ? fresh.reviewCount : (existing.reviewCount as number | undefined);
  const hasTests = fresh.hasTests !== undefined ? fresh.hasTests : (existing.hasTests as boolean | undefined);
  const additions = fresh.additions !== undefined ? fresh.additions : (existing.additions as number | undefined);
  const deletions = fresh.deletions !== undefined ? fresh.deletions : (existing.deletions as number | undefined);
  const changedFiles =
    fresh.changedFiles !== undefined ? fresh.changedFiles : (existing.changedFiles as number | undefined);
  const closesIssues =
    fresh.closesIssues !== undefined ? fresh.closesIssues : (existing.closesIssues as number[] | undefined);
  const headRefOid = fresh.headRefOid !== undefined ? fresh.headRefOid : (existing.headRefOid as string | undefined);
  const nodeId = fresh.nodeId !== undefined ? fresh.nodeId : (existing.nodeId as string | undefined);

  const hasGraphQLFields =
    ciStatus !== undefined || reviewCount !== undefined || hasTests !== undefined || closesIssues !== undefined;

  let provenance: MetadataProvenance = fresh.provenance ?? "rest";
  if (fresh.provenance === "graphql") {
    provenance = "graphql";
  } else if (existing.provenance === "graphql" || hasGraphQLFields) {
    provenance = "graphql";
  }

  return {
    ...fresh,
    ciStatus,
    reviewCount,
    hasTests,
    additions,
    deletions,
    changedFiles,
    closesIssues,
    headRefOid,
    nodeId,
    provenance,
  };
}
