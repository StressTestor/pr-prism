import { Octokit } from "@octokit/rest";
import type { VectorStore } from "../store.js";
import type { PRItem, RateLimitInfo } from "../types.js";
import { createWriteGate, type WriteGate } from "../write-gate.js";
import { fetchIssuesGraphQL, fetchPRsGraphQL, getAuthorMergeCountGraphQL } from "./graphql/index.js";
import { RateLimiter } from "./rate-limit.js";
import {
  applyLabel,
  ensureLabel,
  fetchChangedFiles,
  fetchCIStatus,
  fetchDiff,
  fetchFileContent,
  fetchIssues,
  fetchPRs,
  fetchReviewCount,
  getAuthorMergeCount,
  getPR,
  removeLabel,
} from "./rest/index.js";
import { withRetryBackoff } from "./retry.js";
import type { CIStatus, FetchOptions, GitHubContext, GitHubWriteContext } from "./types.js";

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private rateLimiter: RateLimiter;
  private gate: WriteGate;

  private sleepFn?: (ms: number) => Promise<void>;

  // gate defaults to dry-run: a GitHubClient never mutates the repo unless a
  // caller explicitly hands it an "apply" gate. This is the read-only ethos.
  constructor(
    token: string,
    owner: string,
    repo: string,
    gate: WriteGate = createWriteGate("dry-run"),
    sleepFn?: (ms: number) => Promise<void>,
  ) {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
    this.gate = gate;
    this.rateLimiter = new RateLimiter();
    this.sleepFn = sleepFn;
  }

  getRateLimit(): RateLimitInfo {
    return this.rateLimiter.get();
  }

  private get context(): GitHubContext {
    const self = this;
    return {
      owner: this.owner,
      repo: this.repo,
      get octokit() {
        return self.octokit;
      },
      rateLimiter: this.rateLimiter,
      withBackoff: (fn) => this.withBackoff(fn),
    };
  }

  private get writeContext(): GitHubWriteContext {
    const self = this;
    return {
      owner: this.owner,
      repo: this.repo,
      get octokit() {
        return self.octokit;
      },
      rateLimiter: this.rateLimiter,
      withBackoff: (fn) => this.withBackoff(fn),
      gate: this.gate,
    };
  }

  async withBackoff<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
    return withRetryBackoff(fn, () => this.rateLimiter.get(), this.sleepFn);
  }

  // ── GraphQL methods ───────────────────────────────────────────

  async fetchPRsGraphQL(opts: FetchOptions = {}): Promise<PRItem[]> {
    return fetchPRsGraphQL(this.context, opts);
  }

  async fetchIssuesGraphQL(opts: FetchOptions = {}): Promise<PRItem[]> {
    return fetchIssuesGraphQL(this.context, opts);
  }

  async getAuthorMergeCountGraphQL(author: string): Promise<number> {
    return getAuthorMergeCountGraphQL(this.context, author);
  }

  // ── REST methods (kept as fallback) ───────────────────────────

  async fetchPRs(opts: FetchOptions = {}): Promise<PRItem[]> {
    return fetchPRs(this.context, opts);
  }

  async fetchIssues(opts: FetchOptions = {}): Promise<PRItem[]> {
    return fetchIssues(this.context, opts);
  }

  async getPR(prNumber: number): Promise<PRItem> {
    return getPR(this.context, prNumber);
  }

  async fetchReviewCount(prNumber: number): Promise<number> {
    return fetchReviewCount(this.context, prNumber);
  }

  async fetchChangedFiles(prNumber: number): Promise<string[]> {
    return fetchChangedFiles(this.context, prNumber);
  }

  async fetchDiff(prNumber: number, store?: VectorStore): Promise<string> {
    return fetchDiff(this.context, prNumber, store);
  }

  async fetchCIStatus(prNumber: number): Promise<CIStatus> {
    return fetchCIStatus(this.context, prNumber);
  }

  async applyLabel(number: number, label: string): Promise<void> {
    return applyLabel(this.writeContext, number, label);
  }

  async removeLabel(number: number, label: string): Promise<void> {
    return removeLabel(this.writeContext, number, label);
  }

  async ensureLabel(label: string, color: string, description: string): Promise<void> {
    return ensureLabel(this.writeContext, label, color, description);
  }

  async getAuthorMergeCount(author: string): Promise<number> {
    return getAuthorMergeCount(this.context, author);
  }

  async fetchFileContent(path: string): Promise<string | null> {
    return fetchFileContent(this.context, path);
  }

  estimateAPICallsNeeded(totalPRs: number): number {
    return this.rateLimiter.estimateAPICallsNeeded(totalPRs);
  }

  formatRateLimitWarning(estimatedCalls: number): string | null {
    return this.rateLimiter.formatRateLimitWarning(estimatedCalls);
  }
}
