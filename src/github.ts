/**
 * Compatibility facade for GitHubClient and GitHub integration utilities.
 *
 * Decomposed into modular sub-packages under src/github/:
 * - src/github/client.ts: Main GitHubClient class
 * - src/github/rate-limit.ts: Rate limiter and API accounting
 * - src/github/retry.ts: Transient error handling and backoff
 * - src/github/normalization/: Pure API response normalizers
 * - src/github/graphql/: GraphQL operations and queries
 * - src/github/rest/: REST operations
 */

export { GitHubClient } from "./github/client.js";
export {
  accountIsBot,
  itemClosedAt,
  mapClosingIssues,
  restPRState,
} from "./github/normalization/index.js";
export type { FetchOptions } from "./github/types.js";
