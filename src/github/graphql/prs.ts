import type { PRItem } from "../../types.js";
import { normalizeGraphQLPR } from "../normalization/items.js";
import type { FetchOptions, GitHubContext } from "../types.js";
import { PRS_QUERY } from "./queries.js";

export async function fetchPRsGraphQL(context: GitHubContext, opts: FetchOptions = {}): Promise<PRItem[]> {
  const { since, state = "open", maxItems = 5000, onProgress } = opts;
  const items: PRItem[] = [];

  // Map REST state values to GraphQL enum values, preserving separate handling for OPEN, CLOSED, and MERGED
  const gqlStates =
    state === "all"
      ? ["OPEN", "CLOSED", "MERGED"]
      : state === "closed"
        ? ["CLOSED", "MERGED"]
        : state === "merged"
          ? ["MERGED"]
          : ["OPEN"];

  let cursor: string | null = null;
  let totalCount = 0;
  const repoFull = `${context.owner}/${context.repo}`;
  const seenNumbers = new Set<number>();
  const seenCursors = new Set<string>();

  // Starting page size: default 50 for safety against 502s on historical data (or batchSize if specified, min 5, max 100)
  let currentPageSize = Math.min(Math.max(opts.batchSize ?? 50, 5), 100);
  const minPageSize = 5;

  while (items.length < maxItems) {
    const remaining = maxItems - items.length;
    let queryPageSize = Math.min(currentPageSize, remaining);

    const result: any = await context.withBackoff(async (attempt = 0) => {
      // Adaptive page-size reduction: if an attempt failed with a transient error (502, 504, timeout),
      // halve the page size for this and subsequent requests to relieve GitHub backend complexity
      if (attempt > 0 && queryPageSize > minPageSize) {
        queryPageSize = Math.max(minPageSize, Math.floor(queryPageSize / 2));
        currentPageSize = queryPageSize;
        console.warn(
          `Adaptive GraphQL retry: reduced page size to ${queryPageSize} for ${context.owner}/${context.repo}`,
        );
      }

      return context.octokit.graphql(PRS_QUERY, {
        owner: context.owner,
        repo: context.repo,
        states: gqlStates,
        pageSize: queryPageSize,
        cursor,
      });
    });

    if (!result) {
      throw new Error("GraphQL returned empty result — check token permissions");
    }
    if (result.errors?.length && !result.repository) {
      const msg = result.errors.map((e: any) => e.message).join("; ");
      throw new Error(`GraphQL query error: ${msg}`);
    }
    context.rateLimiter.updateFromGraphQL((result as any).extensions);

    const prs = result.repository?.pullRequests;
    if (!prs) {
      throw new Error(`GraphQL response missing pullRequests for ${context.owner}/${context.repo}`);
    }
    totalCount = prs.totalCount;

    if (!prs.nodes || prs.nodes.length === 0) break;

    for (const pr of prs.nodes) {
      if (items.length >= maxItems) break;

      if (since && new Date(pr.updatedAt) < new Date(since)) {
        onProgress?.(items.length, items.length);
        return items;
      }

      // Deduplication: prevent duplicate items across pages
      if (seenNumbers.has(pr.number)) {
        continue;
      }
      seenNumbers.add(pr.number);

      items.push(normalizeGraphQLPR(pr, repoFull));

      const closingTotal = pr.closingIssuesReferences?.totalCount || 0;
      const closingFetched = pr.closingIssuesReferences?.nodes?.length || 0;
      if (closingTotal > closingFetched) {
        console.warn(`warning: closing refs truncated for PR #${pr.number} (${closingFetched} of ${closingTotal})`);
      }
    }

    onProgress?.(items.length, totalCount);

    if (items.length >= maxItems) break;

    if (!prs.pageInfo?.hasNextPage) break;
    const nextCursor = prs.pageInfo.endCursor;
    // Guard against malformed cursors or cursor loop
    if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return items;
}
