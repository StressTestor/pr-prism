import type { PRItem } from "../../types.js";
import { normalizeGraphQLIssue } from "../normalization/items.js";
import type { FetchOptions, GitHubContext } from "../types.js";
import { ISSUES_QUERY } from "./queries.js";

export async function fetchIssuesGraphQL(context: GitHubContext, opts: FetchOptions = {}): Promise<PRItem[]> {
  const { since, state = "open", maxItems = 5000, onProgress } = opts;
  const items: PRItem[] = [];

  const gqlStates = state === "all" ? ["OPEN", "CLOSED"] : state === "closed" ? ["CLOSED"] : ["OPEN"];
  let cursor: string | null = null;
  let totalCount = 0;
  const repoFull = `${context.owner}/${context.repo}`;
  const seenNumbers = new Set<number>();
  const seenCursors = new Set<string>();

  let currentPageSize = Math.min(Math.max(opts.batchSize ?? 100, 5), 100);
  const minPageSize = 5;

  while (items.length < maxItems) {
    const remaining = maxItems - items.length;
    let queryPageSize = Math.min(currentPageSize, remaining);

    const result: any = await context.withBackoff(async (attempt = 0) => {
      if (attempt > 0 && queryPageSize > minPageSize) {
        queryPageSize = Math.max(minPageSize, Math.floor(queryPageSize / 2));
        currentPageSize = queryPageSize;
        console.warn(
          `Adaptive GraphQL retry: reduced page size to ${queryPageSize} for issues in ${context.owner}/${context.repo}`,
        );
      }

      return context.octokit.graphql(ISSUES_QUERY, {
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

    const issues = result.repository?.issues;
    if (!issues) {
      throw new Error(`GraphQL response missing issues for ${context.owner}/${context.repo}`);
    }
    totalCount = issues.totalCount;

    if (!issues.nodes || issues.nodes.length === 0) break;

    for (const issue of issues.nodes) {
      if (items.length >= maxItems) break;

      if (since && new Date(issue.updatedAt) < new Date(since)) {
        onProgress?.(items.length, items.length);
        return items;
      }

      if (seenNumbers.has(issue.number)) {
        continue;
      }
      seenNumbers.add(issue.number);

      items.push(normalizeGraphQLIssue(issue, repoFull));
    }

    onProgress?.(items.length, totalCount);

    if (items.length >= maxItems) break;

    if (!issues.pageInfo?.hasNextPage) break;
    const nextCursor = issues.pageInfo.endCursor;
    if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return items;
}
