import type { GitHubContext } from "../types.js";
import { AUTHOR_MERGE_COUNT_QUERY } from "./queries.js";

export async function getAuthorMergeCountGraphQL(context: GitHubContext, author: string): Promise<number> {
  try {
    const result: any = await context.withBackoff(() =>
      context.octokit.graphql(AUTHOR_MERGE_COUNT_QUERY, {
        q: `repo:${context.owner}/${context.repo} type:pr author:${author} is:merged`,
      }),
    );
    context.rateLimiter.updateFromGraphQL((result as any).extensions);
    return result.search.issueCount;
  } catch {
    return 0;
  }
}
