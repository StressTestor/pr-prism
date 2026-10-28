import type { PRItem } from "../../types.js";
import { normalizeRestPR } from "../normalization/items.js";
import type { CIStatus, FetchOptions, GitHubContext } from "../types.js";

export async function fetchPRs(context: GitHubContext, opts: FetchOptions = {}): Promise<PRItem[]> {
  const { since, state = "open", maxItems = 5000, batchSize, onProgress } = opts;
  const items: PRItem[] = [];
  let page = 1;
  const repoFull = `${context.owner}/${context.repo}`;
  const seenNumbers = new Set<number>();

  while (items.length < maxItems) {
    const remaining = maxItems - items.length;
    const perPage = Math.min(batchSize ?? 100, remaining, 100);

    const response = await context.withBackoff(() =>
      context.octokit.pulls.list({
        owner: context.owner,
        repo: context.repo,
        state: state === "merged" ? "closed" : state,
        sort: "updated",
        direction: "desc",
        per_page: perPage,
        page,
      }),
    );

    context.rateLimiter.updateFromHeaders(response.headers as Record<string, string>);

    if (!response.data || response.data.length === 0) break;

    for (const pr of response.data) {
      if (items.length >= maxItems) break;

      if (since && new Date(pr.updated_at) < new Date(since)) {
        onProgress?.(items.length, items.length);
        return items;
      }

      if (state === "merged" && !pr.merged_at) {
        continue;
      }

      if (seenNumbers.has(pr.number)) {
        continue;
      }
      seenNumbers.add(pr.number);

      items.push(normalizeRestPR(pr, repoFull));
    }

    onProgress?.(items.length, maxItems);
    if (items.length >= maxItems) break;
    page++;
  }

  return items;
}

export async function getPR(context: GitHubContext, prNumber: number): Promise<PRItem> {
  const response = await context.withBackoff(() =>
    context.octokit.pulls.get({
      owner: context.owner,
      repo: context.repo,
      pull_number: prNumber,
    }),
  );
  context.rateLimiter.updateFromHeaders(response.headers as Record<string, string>);
  return normalizeRestPR(response.data, `${context.owner}/${context.repo}`);
}

export async function fetchReviewCount(context: GitHubContext, prNumber: number): Promise<number> {
  try {
    const response = await context.withBackoff(() =>
      context.octokit.pulls.listReviews({
        owner: context.owner,
        repo: context.repo,
        pull_number: prNumber,
      }),
    );
    context.rateLimiter.updateFromHeaders(response.headers as Record<string, string>);
    return response.data.length;
  } catch {
    return 0;
  }
}

export async function fetchChangedFiles(context: GitHubContext, prNumber: number): Promise<string[]> {
  try {
    const response = await context.withBackoff(() =>
      context.octokit.pulls.listFiles({
        owner: context.owner,
        repo: context.repo,
        pull_number: prNumber,
      }),
    );
    context.rateLimiter.updateFromHeaders(response.headers as Record<string, string>);
    return response.data.map((f) => f.filename);
  } catch {
    return [];
  }
}

export async function fetchCIStatus(context: GitHubContext, prNumber: number): Promise<CIStatus> {
  try {
    const { data: pr } = await context.withBackoff(() =>
      context.octokit.pulls.get({
        owner: context.owner,
        repo: context.repo,
        pull_number: prNumber,
      }),
    );

    const { data: checks } = await context.withBackoff(() =>
      context.octokit.checks.listForRef({
        owner: context.owner,
        repo: context.repo,
        ref: pr.head.sha,
      }),
    );

    if (checks.total_count === 0) return "unknown";

    const allComplete = checks.check_runs.every((c) => c.status === "completed");
    if (!allComplete) return "pending";

    const allSuccess = checks.check_runs.every((c) => c.conclusion === "success");
    return allSuccess ? "success" : "failure";
  } catch {
    return "unknown";
  }
}
