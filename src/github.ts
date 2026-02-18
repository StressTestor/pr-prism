import { Octokit } from "@octokit/rest";
import type { VectorStore } from "./store.js";
import type { PRItem, RateLimitInfo } from "./types.js";

export interface FetchOptions {
  since?: string;
  state?: "open" | "closed" | "all";
  maxItems?: number;
  batchSize?: number;
  onProgress?: (fetched: number, total: number) => void;
}

function hasTestFiles(filenames: string[]): boolean {
  return filenames.some((f) => /test|spec|__tests__/i.test(f));
}

function mapCIStatus(state: string | null | undefined): PRItem["ciStatus"] {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private rateLimit: RateLimitInfo = { remaining: 5000, limit: 5000, resetAt: new Date() };

  constructor(token: string, owner: string, repo: string) {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
  }

  getRateLimit(): RateLimitInfo {
    return { ...this.rateLimit };
  }

  private updateRateLimit(headers: Record<string, string | undefined>) {
    if (headers["x-ratelimit-remaining"]) {
      this.rateLimit.remaining = parseInt(headers["x-ratelimit-remaining"], 10);
    }
    if (headers["x-ratelimit-limit"]) {
      this.rateLimit.limit = parseInt(headers["x-ratelimit-limit"], 10);
    }
    if (headers["x-ratelimit-reset"]) {
      this.rateLimit.resetAt = new Date(parseInt(headers["x-ratelimit-reset"], 10) * 1000);
    }
  }

  private updateGraphQLRateLimit(extensions: any) {
    if (extensions?.rateLimit) {
      const rl = extensions.rateLimit;
      if (rl.remaining != null) this.rateLimit.remaining = rl.remaining;
      if (rl.limit != null) this.rateLimit.limit = rl.limit;
      if (rl.resetAt) this.rateLimit.resetAt = new Date(rl.resetAt);
    }
  }

  async withBackoff<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        if (err.status === 403 && this.rateLimit.remaining === 0) {
          const waitMs = Math.max(0, this.rateLimit.resetAt.getTime() - Date.now()) + 1000;
          console.warn(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (err.status === 403 && attempt < 2) {
          const delay = (attempt + 1) * 5000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

  // ── GraphQL methods ───────────────────────────────────────────

  async fetchPRsGraphQL(opts: FetchOptions = {}): Promise<PRItem[]> {
    const { since, state = "open", maxItems = 5000, onProgress } = opts;
    const items: PRItem[] = [];

    // Map REST state values to GraphQL enum values
    const gqlStates =
      state === "all" ? ["OPEN", "CLOSED", "MERGED"] : state === "closed" ? ["CLOSED", "MERGED"] : ["OPEN"];

    let cursor: string | null = null;
    let totalCount = 0;

    while (items.length < maxItems) {
      const result: any = await this.withBackoff(() =>
        this.octokit.graphql(
          `
          query($owner: String!, $repo: String!, $states: [PullRequestState!]!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              pullRequests(first: 100, after: $cursor, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  number
                  title
                  body
                  state
                  author { login }
                  createdAt
                  updatedAt
                  additions
                  deletions
                  changedFiles
                  labels(first: 20) { nodes { name } }
                  reviews { totalCount }
                  files(first: 100) { totalCount nodes { path } }
                  commits(last: 1) {
                    nodes {
                      commit {
                        statusCheckRollup { state }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
          {
            owner: this.owner,
            repo: this.repo,
            states: gqlStates,
            cursor,
          },
        ),
      );

      this.updateGraphQLRateLimit((result as any).extensions);

      const prs = result.repository.pullRequests;
      totalCount = prs.totalCount;

      if (prs.nodes.length === 0) break;

      for (const pr of prs.nodes) {
        if (since && new Date(pr.updatedAt) < new Date(since)) {
          onProgress?.(items.length, items.length);
          return items;
        }

        const fileNodes: string[] = (pr.files?.nodes || []).map((f: any) => f.path);
        const fileTotalCount: number = pr.files?.totalCount || 0;
        const foundTests = hasTestFiles(fileNodes);
        // If 100+ files and no test found in first 100, we can't be sure — default to undefined (neutral 0.5)
        const hasTests = foundTests ? true : fileTotalCount > 100 ? undefined : false;

        const ciRollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;

        items.push({
          number: pr.number,
          type: "pr",
          repo: `${this.owner}/${this.repo}`,
          title: pr.title,
          body: pr.body || "",
          state: pr.state.toLowerCase(),
          author: pr.author?.login || "unknown",
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          labels: (pr.labels?.nodes || []).map((l: any) => l.name),
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          ciStatus: mapCIStatus(ciRollup),
          reviewCount: pr.reviews?.totalCount || 0,
          hasTests,
        });
      }

      onProgress?.(items.length, totalCount);

      if (!prs.pageInfo.hasNextPage) break;
      cursor = prs.pageInfo.endCursor;
    }

    return items;
  }

  async fetchIssuesGraphQL(opts: FetchOptions = {}): Promise<PRItem[]> {
    const { since, state = "open", maxItems = 5000, onProgress } = opts;
    const items: PRItem[] = [];

    const gqlStates = state === "all" ? ["OPEN", "CLOSED"] : state === "closed" ? ["CLOSED"] : ["OPEN"];
    let cursor: string | null = null;
    let totalCount = 0;

    while (items.length < maxItems) {
      const result: any = await this.withBackoff(() =>
        this.octokit.graphql(
          `
          query($owner: String!, $repo: String!, $states: [IssueState!]!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              issues(first: 100, after: $cursor, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  number
                  title
                  body
                  state
                  author { login }
                  createdAt
                  updatedAt
                  labels(first: 20) { nodes { name } }
                }
              }
            }
          }
        `,
          {
            owner: this.owner,
            repo: this.repo,
            states: gqlStates,
            cursor,
          },
        ),
      );

      this.updateGraphQLRateLimit((result as any).extensions);

      const issues = result.repository.issues;
      totalCount = issues.totalCount;

      if (issues.nodes.length === 0) break;

      for (const issue of issues.nodes) {
        if (since && new Date(issue.updatedAt) < new Date(since)) {
          onProgress?.(items.length, items.length);
          return items;
        }

        items.push({
          number: issue.number,
          type: "issue",
          repo: `${this.owner}/${this.repo}`,
          title: issue.title,
          body: issue.body || "",
          state: issue.state.toLowerCase(),
          author: issue.author?.login || "unknown",
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          labels: (issue.labels?.nodes || []).map((l: any) => l.name),
        });
      }

      onProgress?.(items.length, totalCount);

      if (!issues.pageInfo.hasNextPage) break;
      cursor = issues.pageInfo.endCursor;
    }

    return items;
  }

  async getAuthorMergeCountGraphQL(author: string): Promise<number> {
    try {
      const result: any = await this.withBackoff(() =>
        this.octokit.graphql(
          `
          query($q: String!) {
            search(query: $q, type: ISSUE, first: 0) { issueCount }
          }
        `,
          {
            q: `repo:${this.owner}/${this.repo} type:pr author:${author} is:merged`,
          },
        ),
      );
      this.updateGraphQLRateLimit((result as any).extensions);
      return result.search.issueCount;
    } catch {
      return 0;
    }
  }

  // ── REST methods (kept as fallback) ───────────────────────────

  async fetchPRs(opts: FetchOptions = {}): Promise<PRItem[]> {
    const { since, state = "open", maxItems = 5000, batchSize = 50, onProgress } = opts;
    const items: PRItem[] = [];
    let page = 1;

    while (items.length < maxItems) {
      const response = await this.withBackoff(() =>
        this.octokit.pulls.list({
          owner: this.owner,
          repo: this.repo,
          state,
          sort: "updated",
          direction: "desc",
          per_page: Math.min(batchSize, 100),
          page,
        }),
      );

      this.updateRateLimit(response.headers as Record<string, string>);

      if (response.data.length === 0) break;

      for (const pr of response.data) {
        if (since && new Date(pr.updated_at) < new Date(since)) {
          onProgress?.(items.length, items.length);
          return items;
        }

        items.push({
          number: pr.number,
          type: "pr",
          repo: `${this.owner}/${this.repo}`,
          title: pr.title,
          body: pr.body || "",
          state: pr.state,
          author: pr.user?.login || "unknown",
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name || "")),
          diffUrl: pr.diff_url,
          additions: (pr as any).additions,
          deletions: (pr as any).deletions,
          changedFiles: (pr as any).changed_files,
        });
      }

      onProgress?.(items.length, maxItems);
      page++;
    }

    return items;
  }

  async fetchIssues(opts: FetchOptions = {}): Promise<PRItem[]> {
    const { since, state = "open", maxItems = 5000, batchSize = 50, onProgress } = opts;
    const items: PRItem[] = [];
    let page = 1;

    while (items.length < maxItems) {
      const response = await this.withBackoff(() =>
        this.octokit.issues.listForRepo({
          owner: this.owner,
          repo: this.repo,
          state: state === "all" ? "all" : state,
          sort: "updated",
          direction: "desc",
          per_page: Math.min(batchSize, 100),
          page,
        }),
      );

      this.updateRateLimit(response.headers as Record<string, string>);

      if (response.data.length === 0) break;

      for (const issue of response.data) {
        if (issue.pull_request) continue;

        if (since && new Date(issue.updated_at) < new Date(since)) {
          onProgress?.(items.length, items.length);
          return items;
        }

        items.push({
          number: issue.number,
          type: "issue",
          repo: `${this.owner}/${this.repo}`,
          title: issue.title,
          body: issue.body || "",
          state: issue.state,
          author: issue.user?.login || "unknown",
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name || "")),
        });
      }

      onProgress?.(items.length, maxItems);
      page++;
    }

    return items;
  }

  async getPR(prNumber: number): Promise<PRItem> {
    const response = await this.withBackoff(() =>
      this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      }),
    );
    this.updateRateLimit(response.headers as Record<string, string>);
    const pr = response.data;
    return {
      number: pr.number,
      type: "pr",
      repo: `${this.owner}/${this.repo}`,
      title: pr.title,
      body: pr.body || "",
      state: pr.state,
      author: pr.user?.login || "unknown",
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name || "")),
      diffUrl: pr.diff_url,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
    };
  }

  async fetchReviewCount(prNumber: number): Promise<number> {
    try {
      const response = await this.withBackoff(() =>
        this.octokit.pulls.listReviews({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        }),
      );
      this.updateRateLimit(response.headers as Record<string, string>);
      return response.data.length;
    } catch {
      return 0;
    }
  }

  async fetchChangedFiles(prNumber: number): Promise<string[]> {
    try {
      const response = await this.withBackoff(() =>
        this.octokit.pulls.listFiles({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        }),
      );
      this.updateRateLimit(response.headers as Record<string, string>);
      return response.data.map((f) => f.filename);
    } catch {
      return [];
    }
  }

  async fetchDiff(prNumber: number, store?: VectorStore): Promise<string> {
    const repoFull = `${this.owner}/${this.repo}`;

    if (store) {
      const cached = store.getCachedDiff(repoFull, prNumber);
      if (cached) return cached;
    }

    const response = await this.withBackoff(() =>
      this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        mediaType: { format: "diff" },
      }),
    );

    this.updateRateLimit(response.headers as Record<string, string>);

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

  async fetchCIStatus(prNumber: number): Promise<"success" | "failure" | "pending" | "unknown"> {
    try {
      const { data: pr } = await this.withBackoff(() =>
        this.octokit.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        }),
      );

      const { data: checks } = await this.withBackoff(() =>
        this.octokit.checks.listForRef({
          owner: this.owner,
          repo: this.repo,
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

  async applyLabel(number: number, label: string): Promise<void> {
    await this.withBackoff(() =>
      this.octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        labels: [label],
      }),
    );
  }

  async removeLabel(number: number, label: string): Promise<void> {
    try {
      await this.withBackoff(() =>
        this.octokit.issues.removeLabel({
          owner: this.owner,
          repo: this.repo,
          issue_number: number,
          name: label,
        }),
      );
    } catch {
      // Label might not exist
    }
  }

  async ensureLabel(label: string, color: string, description: string): Promise<void> {
    try {
      await this.octokit.issues.getLabel({
        owner: this.owner,
        repo: this.repo,
        name: label,
      });
    } catch {
      await this.octokit.issues.createLabel({
        owner: this.owner,
        repo: this.repo,
        name: label,
        color,
        description,
      });
    }
  }

  async getAuthorMergeCount(author: string): Promise<number> {
    try {
      const response = await this.withBackoff(() =>
        this.octokit.search.issuesAndPullRequests({
          q: `repo:${this.owner}/${this.repo} type:pr author:${author} is:merged`,
        }),
      );
      this.updateRateLimit(response.headers as Record<string, string>);
      return response.data.total_count;
    } catch {
      return 0;
    }
  }

  async fetchFileContent(path: string): Promise<string | null> {
    try {
      const { data } = await this.withBackoff(() =>
        this.octokit.repos.getContent({
          owner: this.owner,
          repo: this.repo,
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

  estimateAPICallsNeeded(totalPRs: number): number {
    return Math.ceil(totalPRs / 100) + totalPRs;
  }

  formatRateLimitWarning(estimatedCalls: number): string | null {
    if (this.rateLimit.remaining > estimatedCalls * 1.2) return null;
    const resetMin = Math.ceil((this.rateLimit.resetAt.getTime() - Date.now()) / 60000);
    return `⚠ ${this.rateLimit.remaining}/${this.rateLimit.limit} API calls remaining, ~${estimatedCalls} needed. Resets in ${resetMin}min.`;
  }
}
