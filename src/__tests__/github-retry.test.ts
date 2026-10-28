import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../errors.js";
import { RateLimiter } from "../github/rate-limit.js";
import { withRetryBackoff } from "../github/retry.js";
import { GitHubClient } from "../github.js";

describe("Retry behavior & API failures", () => {
  it("throws ProviderError immediately on 403 when rate limit is not exhausted", async () => {
    const fn = vi.fn().mockRejectedValue({
      status: 403,
      message: "Resource not accessible by integration",
    });

    const rl = () => ({ remaining: 4500, limit: 5000, resetAt: new Date(Date.now() + 60000) });
    const sleepMock = vi.fn();

    await expect(withRetryBackoff(fn, rl, sleepMock)).rejects.toThrow(ProviderError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("retries on 403 when rate limit remaining is 0", async () => {
    const resetTime = new Date(Date.now() + 10000);
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err: any = new Error("Rate limit exceeded");
        err.status = 403;
        throw err;
      }
      return { success: true };
    });

    let remaining = 0;
    const rl = () => ({ remaining, limit: 5000, resetAt: resetTime });
    const sleepMock = vi.fn().mockImplementation(async () => {
      remaining = 5000;
    });

    const result = await withRetryBackoff(fn, rl, sleepMock);
    expect(result).toEqual({ success: true });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
  });

  it("retries on 429 and respects retry-after header", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err: any = new Error("Too many requests");
        err.status = 429;
        err.response = { headers: { "retry-after": "5" } };
        throw err;
      }
      return { ok: true };
    });

    const sleepMock = vi.fn();
    const result = await withRetryBackoff(fn, undefined, sleepMock);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(5000);
  });

  it("retries transient 500, 502, 503 errors with incremental backoff", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        const err: any = new Error("Bad Gateway 502");
        err.status = 502;
        throw err;
      }
      return "recovered";
    });

    const sleepMock = vi.fn();
    const result = await withRetryBackoff(fn, undefined, sleepMock);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock.mock.calls[0][0]).toBe(5000); // (0 + 1) * 5000
    expect(sleepMock.mock.calls[1][0]).toBe(10000); // (1 + 1) * 5000
  });

  it("throws after 5 failed transient attempts", async () => {
    const fn = vi.fn().mockImplementation(async () => {
      const err: any = new Error("Service Unavailable");
      err.status = 503;
      throw err;
    });

    const sleepMock = vi.fn();
    await expect(withRetryBackoff(fn, undefined, sleepMock)).rejects.toThrow("Service Unavailable");
    expect(fn).toHaveBeenCalledTimes(5);
    expect(sleepMock).toHaveBeenCalledTimes(4);
  });

  it("throws when API returns null or undefined", async () => {
    const fnNull = vi.fn().mockResolvedValue(null);
    await expect(withRetryBackoff(fnNull)).rejects.toThrow("API returned empty response");

    const fnUndefined = vi.fn().mockResolvedValue(undefined);
    await expect(withRetryBackoff(fnUndefined)).rejects.toThrow("API returned empty response");
  });

  it("throws immediately on GraphQL empty result or missing pullRequests", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      graphql: vi.fn().mockResolvedValueOnce(null),
    };

    // null return gets caught by withBackoff as "API returned empty response"
    await expect(client.fetchPRsGraphQL()).rejects.toThrow("API returned empty response");

    (client as any).octokit = {
      graphql: vi.fn().mockResolvedValueOnce({ repository: {} }),
    };

    await expect(client.fetchPRsGraphQL()).rejects.toThrow("GraphQL response missing pullRequests for owner/repo");
  });
});

describe("Rate-limit accounting & warnings", () => {
  it("updates rate limit state from REST response headers", () => {
    const limiter = new RateLimiter();
    limiter.updateFromHeaders({
      "x-ratelimit-remaining": "3421",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": "1700000000",
    });

    const info = limiter.get();
    expect(info.remaining).toBe(3421);
    expect(info.limit).toBe(5000);
    expect(info.resetAt.getTime()).toBe(1700000000 * 1000);
  });

  it("updates rate limit state from GraphQL extensions", () => {
    const limiter = new RateLimiter();
    const resetDate = new Date(Date.now() + 3600000).toISOString();
    limiter.updateFromGraphQL({
      rateLimit: {
        remaining: 2500,
        limit: 5000,
        resetAt: resetDate,
      },
    });

    const info = limiter.get();
    expect(info.remaining).toBe(2500);
    expect(info.limit).toBe(5000);
    expect(info.resetAt.toISOString()).toBe(resetDate);
  });

  it("correctly estimates API calls needed", () => {
    const limiter = new RateLimiter();
    expect(limiter.estimateAPICallsNeeded(100)).toBe(101);
    expect(limiter.estimateAPICallsNeeded(250)).toBe(253);
    expect(limiter.estimateAPICallsNeeded(0)).toBe(0);
  });

  it("formats warning when remaining calls are insufficient, null when ample", () => {
    const limiter = new RateLimiter();
    limiter.updateFromHeaders({
      "x-ratelimit-remaining": "100",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": `${Math.floor((Date.now() + 1800000) / 1000)}`,
    });

    // 100 remaining, 100 needed: 100 <= 100 * 1.2 -> warning
    const warning = limiter.formatRateLimitWarning(100);
    expect(warning).not.toBeNull();
    expect(warning).toContain("⚠ 100/5000 API calls remaining");
    expect(warning).toContain("Resets in");

    // 100 remaining, 10 needed: 100 > 12 -> null
    expect(limiter.formatRateLimitWarning(10)).toBeNull();
  });
});
