import { Octokit } from "@octokit/rest";
import type { PRItem, RateLimitInfo } from "./types.js";
import type { VectorStore } from "./store.js";

export interface FetchOptions {
  since?: string;
  state?: "open" | "closed" | "all";
  maxItems?: number;
  batchSize?: number;
  onProgress?: (fetched: number, total: number) => void;
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

  async withBackoff<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        if (err.status === 403 && this.rateLimit.remaining === 0) {
          const waitMs = Math.max(0, this.rateLimit.resetAt.getTime() - Date.now()) + 1000;
          console.warn(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        if (err.status === 403 && attempt < 2) {
          const delay = (attempt + 1) * 5000;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

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
        })
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
          labels: pr.labels.map(l => (typeof l === "string" ? l : l.name || "")),
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
        })
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
          labels: issue.labels.map(l => (typeof l === "string" ? l : l.name || "")),
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
      })
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
      labels: pr.labels.map(l => (typeof l === "string" ? l : l.name || "")),
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
        })
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
        })
      );
      this.updateRateLimit(response.headers as Record<string, string>);
      return response.data.map(f => f.filename);
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
      })
    );

    this.updateRateLimit(response.headers as Record<string, string>);

    let diff = response.data as unknown as string;

    const MAX_DIFF = 500_000;
    if (diff.length > MAX_DIFF) {
      diff = diff.slice(0, MAX_DIFF) + "\n\n[TRUNCATED — diff exceeded 500KB]";
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
        })
      );

      const { data: checks } = await this.withBackoff(() =>
        this.octokit.checks.listForRef({
          owner: this.owner,
          repo: this.repo,
          ref: pr.head.sha,
        })
      );

      if (checks.total_count === 0) return "unknown";

      const allComplete = checks.check_runs.every(c => c.status === "completed");
      if (!allComplete) return "pending";

      const allSuccess = checks.check_runs.every(c => c.conclusion === "success");
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
      })
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
        })
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
        })
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
        })
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
