import type { RateLimitInfo } from "../types.js";

export class RateLimiter {
  private rateLimit: RateLimitInfo;

  constructor(initial?: RateLimitInfo) {
    this.rateLimit = initial ? { ...initial } : { remaining: 5000, limit: 5000, resetAt: new Date() };
  }

  get(): RateLimitInfo {
    return { ...this.rateLimit };
  }

  get remaining(): number {
    return this.rateLimit.remaining;
  }

  get resetAt(): Date {
    return this.rateLimit.resetAt;
  }

  get limit(): number {
    return this.rateLimit.limit;
  }

  updateFromHeaders(headers: Record<string, string | undefined>): void {
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

  updateFromGraphQL(extensions: any): void {
    if (extensions?.rateLimit) {
      const rl = extensions.rateLimit;
      if (rl.remaining != null) this.rateLimit.remaining = rl.remaining;
      if (rl.limit != null) this.rateLimit.limit = rl.limit;
      if (rl.resetAt) this.rateLimit.resetAt = new Date(rl.resetAt);
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
