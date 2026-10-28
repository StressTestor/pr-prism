import type { VectorStore } from "../../store.js";
import type { GitHubContext } from "../types.js";

export async function fetchDiff(context: GitHubContext, prNumber: number, store?: VectorStore): Promise<string> {
  const repoFull = `${context.owner}/${context.repo}`;

  if (store) {
    const cached = store.getCachedDiff(repoFull, prNumber);
    if (cached) return cached;
  }

  const response = await context.withBackoff(() =>
    context.octokit.pulls.get({
      owner: context.owner,
      repo: context.repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    }),
  );

  context.rateLimiter.updateFromHeaders(response.headers as Record<string, string>);

  let diff = response.data as unknown as string;

  const MAX_DIFF = 500_000;
  if (diff.length > MAX_DIFF) {
    diff = `${diff.slice(0, MAX_DIFF)}\n\n[TRUNCATED — diff exceeded 500KB]`;
  }

  if (store) {
    store.cacheDiff(repoFull, prNumber, diff);
  }

  return diff;
}
