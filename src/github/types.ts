import type { Octokit } from "@octokit/rest";
import type { WriteGate } from "../write-gate.js";
import type { RateLimiter } from "./rate-limit.js";

export interface FetchOptions {
  since?: string;
  state?: "open" | "closed" | "merged" | "all";
  maxItems?: number;
  batchSize?: number;
  onProgress?: (fetched: number, total: number) => void;
}

export type CIStatus = "success" | "failure" | "pending" | "unknown";

export interface GitHubContext {
  readonly owner: string;
  readonly repo: string;
  readonly octokit: Octokit;
  readonly rateLimiter: RateLimiter;
  withBackoff<T>(fn: (attempt: number) => Promise<T>): Promise<T>;
}

export interface GitHubWriteContext extends GitHubContext {
  readonly gate: WriteGate;
}
