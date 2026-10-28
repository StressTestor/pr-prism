import type { PRItem } from "../../types.js";
import { normalizeRestIssue } from "../normalization/items.js";
import type { FetchOptions, GitHubContext } from "../types.js";

export async function fetchIssues(context: GitHubContext, opts: FetchOptions = {}): Promise<PRItem[]> {
  const { since, state = "open", maxItems = 5000, batchSize, onProgress } = opts;
  const items: PRItem[] = [];
  let page = 1;
  const repoFull = `${context.owner}/${context.repo}`;
  const seenNumbers = new Set<number>();

  while (items.length < maxItems) {
    const remaining = maxItems - items.length;
    const perPage = Math.min(batchSize ?? 100, remaining, 100);

    const response = await context.withBackoff(() =>
      context.octokit.issues.listForRepo({
        owner: context.owner,
        repo: context.repo,
        state: state === "all" ? "all" : state === "merged" ? "closed" : state,
        sort: "updated",
        direction: "desc",
        per_page: perPage,
        page,
      }),
    );

    context.rateLimiter.updateFromHeaders(response.headers as Record<string, string>);

    if (!response.data || response.data.length === 0) break;

    for (const issue of response.data) {
      if (issue.pull_request) continue;
      if (items.length >= maxItems) break;

      if (since && new Date(issue.updated_at) < new Date(since)) {
        onProgress?.(items.length, items.length);
        return items;
      }

      if (seenNumbers.has(issue.number)) {
        continue;
      }
      seenNumbers.add(issue.number);

      items.push(normalizeRestIssue(issue, repoFull));
    }

    onProgress?.(items.length, maxItems);
    if (items.length >= maxItems) break;
    page++;
  }

  return items;
}
