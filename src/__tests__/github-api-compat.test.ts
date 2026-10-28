import { describe, expect, it } from "vitest";
import * as githubPackage from "../github/index.js";
import * as githubFacade from "../github.js";

describe("GitHubClient public API compatibility", () => {
  it("exports all expected facade contracts from src/github.ts and no internal leakages", () => {
    expect(typeof githubFacade.GitHubClient).toBe("function");
    expect(typeof githubFacade.restPRState).toBe("function");
    expect(typeof githubFacade.itemClosedAt).toBe("function");
    expect(typeof githubFacade.accountIsBot).toBe("function");
    expect(typeof githubFacade.mapClosingIssues).toBe("function");

    // Exact runtime exports check: verify no internal operation functions leak through facade
    const facadeExports = Object.keys(githubFacade).sort();
    expect(facadeExports).toEqual(["GitHubClient", "accountIsBot", "itemClosedAt", "mapClosingIssues", "restPRState"]);
  });

  it("exports modular building blocks from src/github/index.ts", () => {
    expect(typeof githubPackage.RateLimiter).toBe("function");
    expect(typeof githubPackage.withRetryBackoff).toBe("function");
    expect(typeof githubPackage.PRS_QUERY).toBe("string");
    expect(typeof githubPackage.ISSUES_QUERY).toBe("string");
    expect(typeof githubPackage.AUTHOR_MERGE_COUNT_QUERY).toBe("string");
    expect(typeof githubPackage.normalizeGraphQLPR).toBe("function");
    expect(typeof githubPackage.normalizeGraphQLIssue).toBe("function");
    expect(typeof githubPackage.normalizeRestPR).toBe("function");
    expect(typeof githubPackage.normalizeRestIssue).toBe("function");
  });

  it("GitHubClient maintains all expected public methods and signatures", () => {
    const client = new githubFacade.GitHubClient("mock-token", "owner", "repo");

    const expectedMethods = [
      "getRateLimit",
      "withBackoff",
      "fetchPRsGraphQL",
      "fetchIssuesGraphQL",
      "getAuthorMergeCountGraphQL",
      "fetchPRs",
      "fetchIssues",
      "getPR",
      "fetchReviewCount",
      "fetchChangedFiles",
      "fetchDiff",
      "fetchCIStatus",
      "applyLabel",
      "removeLabel",
      "ensureLabel",
      "getAuthorMergeCount",
      "fetchFileContent",
      "estimateAPICallsNeeded",
      "formatRateLimitWarning",
    ];

    expect(expectedMethods).toHaveLength(19);

    for (const method of expectedMethods) {
      expect(typeof (client as any)[method]).toBe("function");
    }
  });

  it("GitHubClient initializes with expected default rate limit and estimate helpers", () => {
    const client = new githubFacade.GitHubClient("mock-token", "owner", "repo");
    const rl = client.getRateLimit();
    expect(rl.remaining).toBe(5000);
    expect(rl.limit).toBe(5000);
    expect(rl.resetAt).toBeInstanceOf(Date);

    expect(client.estimateAPICallsNeeded(50)).toBe(51);
    expect(client.formatRateLimitWarning(10)).toBeNull();
  });
});
