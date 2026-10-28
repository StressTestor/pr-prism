import { ProviderError } from "../errors.js";
import type { RateLimitInfo } from "../types.js";

export async function withRetryBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  getRateLimit?: () => RateLimitInfo,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await fn(attempt);
      if (result === undefined || result === null) {
        throw new Error("API returned empty response");
      }
      return result;
    } catch (err: any) {
      // 401 Unauthorized — authentication failure: fail immediately, never retry
      if (err.status === 401) {
        throw new ProviderError(
          "GitHub",
          "Authentication failed (401)",
          "Check your GITHUB_TOKEN or generate a new token at https://github.com/settings/tokens",
          401,
        );
      }
      // 429 rate limit — wait and retry
      if (err.status === 429) {
        const retryAfter = parseInt(err.response?.headers?.["retry-after"] || "60", 10);
        const waitMs = retryAfter * 1000;
        console.warn(`Rate limited (429). Waiting ${retryAfter}s...`);
        await sleepFn(waitMs);
        continue;
      }
      // 403 with rate limit exhausted — wait for reset
      const rl = getRateLimit?.();
      if (err.status === 403 && rl && rl.remaining === 0) {
        const waitMs = Math.max(0, rl.resetAt.getTime() - Date.now()) + 1000;
        console.warn(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
        await sleepFn(waitMs);
        continue;
      }
      // 403 permission error (not rate limit) — fail with actionable message
      if (err.status === 403) {
        throw new ProviderError(
          "GitHub",
          "Token lacks required scopes",
          "Needs `repo` for private repos, `public_repo` for public. Generate at https://github.com/settings/tokens",
          403,
        );
      }
      // Transient errors (500, 502, 503, 504, timeouts, network transport) — retry with backoff
      const errStatus = err.status || err.response?.status;
      const errMsg = err.message || "";
      const isTransient =
        errStatus === 500 ||
        errStatus === 502 ||
        errStatus === 503 ||
        errStatus === 504 ||
        errMsg.includes("500") ||
        errMsg.includes("502") ||
        errMsg.includes("503") ||
        errMsg.includes("504") ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ECONNREFUSED" ||
        err.code === "UND_ERR_CONNECT_TIMEOUT" ||
        err.name === "AbortError" ||
        err.name === "TimeoutError" ||
        /timeout|hang up|reset/i.test(errMsg);

      if (attempt < 4 && isTransient) {
        const delay = (attempt + 1) * 5000;
        console.warn(`Transient error (${errStatus || errMsg.slice(0, 40)}). Retrying in ${delay / 1000}s...`);
        await sleepFn(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}
