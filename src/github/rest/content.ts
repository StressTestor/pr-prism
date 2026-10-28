import type { GitHubContext } from "../types.js";

export async function fetchFileContent(context: GitHubContext, path: string): Promise<string | null> {
  try {
    const { data } = await context.withBackoff(() =>
      context.octokit.repos.getContent({
        owner: context.owner,
        repo: context.repo,
        path,
      }),
    );
    if ("content" in data && data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}
