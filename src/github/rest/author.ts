import type { GitHubContext } from "../types.js";

export async function getAuthorMergeCount(context: GitHubContext, author: string): Promise<number> {
  try {
    const response = await context.withBackoff(() =>
      context.octokit.search.issuesAndPullRequests({
        q: `repo:${context.owner}/${context.repo} type:pr author:${author} is:merged`,
      }),
    );
    context.rateLimiter.updateFromHeaders(response.headers as Record<string, string>);
    return response.data.total_count;
  } catch {
    return 0;
  }
}
