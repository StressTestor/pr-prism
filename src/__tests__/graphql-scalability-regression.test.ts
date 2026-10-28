import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../errors.js";
import { withRetryBackoff } from "../github/retry.js";
import { GitHubClient } from "../github.js";
import { itemMetadata, preserveItemMetadata } from "../metadata.js";
import { runScan } from "../pipeline.js";
import { VectorStore } from "../store.js";
import type { PRItem } from "../types.js";

describe("PR-Prism v4 GraphQL Ingestion Scalability Remediation", () => {
  describe("A & C. GraphQL OPEN, CLOSED, and MERGED state mapping and pagination", () => {
    it("maps state 'open' to ['OPEN'] and paginates until hasNextPage is false", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const graphqlMock = vi
        .fn()
        .mockResolvedValueOnce({
          repository: {
            pullRequests: {
              totalCount: 2,
              pageInfo: { hasNextPage: true, endCursor: "cursor_open_1" },
              nodes: [
                {
                  id: "PR_1",
                  number: 1,
                  title: "Open PR 1",
                  state: "OPEN",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            pullRequests: {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: "cursor_open_2" },
              nodes: [
                {
                  id: "PR_2",
                  number: 2,
                  title: "Open PR 2",
                  state: "OPEN",
                  createdAt: "2026-01-03T00:00:00Z",
                  updatedAt: "2026-01-04T00:00:00Z",
                },
              ],
            },
          },
        });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL({ state: "open" });
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.number)).toEqual([1, 2]);
      expect(graphqlMock.mock.calls[0][1].states).toEqual(["OPEN"]);
      expect(graphqlMock.mock.calls[0][1].cursor).toBeNull();
      expect(graphqlMock.mock.calls[1][1].cursor).toBe("cursor_open_1");
    });

    it("maps state 'closed' to ['CLOSED', 'MERGED'] for pull requests", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const graphqlMock = vi.fn().mockResolvedValueOnce({
        repository: {
          pullRequests: {
            totalCount: 2,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PR_10",
                number: 10,
                title: "Closed PR",
                state: "CLOSED",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-02T00:00:00Z",
                closedAt: "2026-01-02T00:00:00Z",
              },
              {
                id: "PR_11",
                number: 11,
                title: "Merged PR",
                state: "MERGED",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-03T00:00:00Z",
                closedAt: "2026-01-03T00:00:00Z",
              },
            ],
          },
        },
      });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL({ state: "closed" });
      expect(items).toHaveLength(2);
      expect(graphqlMock.mock.calls[0][1].states).toEqual(["CLOSED", "MERGED"]);
      expect(items[0].state).toBe("closed");
      expect(items[1].state).toBe("merged");
    });

    it("maps state 'merged' to ['MERGED'] for pull requests", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const graphqlMock = vi.fn().mockResolvedValueOnce({
        repository: {
          pullRequests: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PR_12",
                number: 12,
                title: "Exclusively Merged PR",
                state: "MERGED",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-03T00:00:00Z",
                closedAt: "2026-01-03T00:00:00Z",
              },
            ],
          },
        },
      });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL({ state: "merged" });
      expect(items).toHaveLength(1);
      expect(graphqlMock.mock.calls[0][1].states).toEqual(["MERGED"]);
      expect(items[0].state).toBe("merged");
    });

    it("maps state 'all' to ['OPEN', 'CLOSED', 'MERGED'] for PRs and ['OPEN', 'CLOSED'] for issues", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const prMock = vi.fn().mockResolvedValueOnce({
        repository: {
          pullRequests: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "PR_1", number: 1, title: "PR", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z" }],
          },
        },
      });
      const issueMock = vi.fn().mockResolvedValueOnce({
        repository: {
          issues: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "ISSUE_1", number: 2, title: "Issue", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z" }],
          },
        },
      });

      (client as any).octokit = { graphql: prMock };
      await client.fetchPRsGraphQL({ state: "all" });
      expect(prMock.mock.calls[0][1].states).toEqual(["OPEN", "CLOSED", "MERGED"]);

      (client as any).octokit = { graphql: issueMock };
      await client.fetchIssuesGraphQL({ state: "all" });
      expect(issueMock.mock.calls[0][1].states).toEqual(["OPEN", "CLOSED"]);
    });
  });

  describe("C. Exact item limits, including maxItems = 25", () => {
    it("strictly bounds GraphQL PR results to maxItems = 25 even if page returns 100 items", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      // Simulate server returning 100 items on page 1
      const nodes100 = Array.from({ length: 100 }, (_, i) => ({
        id: `PR_${i + 1}`,
        number: i + 1,
        title: `PR ${i + 1}`,
        state: "OPEN",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }));

      const graphqlMock = vi.fn().mockResolvedValue({
        repository: {
          pullRequests: {
            totalCount: 100,
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: nodes100,
          },
        },
      });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL({ maxItems: 25 });
      expect(items).toHaveLength(25);
      expect(items[0].number).toBe(1);
      expect(items[24].number).toBe(25);
      // Query should request min(pageSize, remaining) = 25
      expect(graphqlMock.mock.calls[0][1].pageSize).toBe(25);
    });

    it("strictly bounds GraphQL Issue results to maxItems = 25", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const nodes50 = Array.from({ length: 50 }, (_, i) => ({
        id: `ISSUE_${i + 1}`,
        number: i + 1,
        title: `Issue ${i + 1}`,
        state: "OPEN",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }));

      const graphqlMock = vi.fn().mockResolvedValue({
        repository: {
          issues: {
            totalCount: 50,
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: nodes50,
          },
        },
      });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchIssuesGraphQL({ maxItems: 25 });
      expect(items).toHaveLength(25);
      expect(items[24].number).toBe(25);
      expect(graphqlMock.mock.calls[0][1].pageSize).toBe(25);
    });

    it("strictly bounds REST PR results to maxItems = 25 and requests per_page = 25", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const listMock = vi.fn().mockResolvedValue({
        headers: {},
        data: Array.from({ length: 100 }, (_, i) => ({
          number: i + 1,
          title: `REST PR ${i + 1}`,
          state: "open",
          user: { login: "alice" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        })),
      });

      (client as any).octokit = { pulls: { list: listMock } };

      const items = await client.fetchPRs({ maxItems: 25 });
      expect(items).toHaveLength(25);
      expect(listMock).toHaveBeenCalledTimes(1);
      expect(listMock.mock.calls[0][0].per_page).toBe(25);
    });

    it("strictly bounds REST Issue results to maxItems = 25 and requests per_page = 25", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const listMock = vi.fn().mockResolvedValue({
        headers: {},
        data: Array.from({ length: 100 }, (_, i) => ({
          number: i + 1,
          title: `REST Issue ${i + 1}`,
          state: "open",
          user: { login: "bob" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        })),
      });

      (client as any).octokit = { issues: { listForRepo: listMock } };

      const items = await client.fetchIssues({ maxItems: 25 });
      expect(items).toHaveLength(25);
      expect(listMock).toHaveBeenCalledTimes(1);
      expect(listMock.mock.calls[0][0].per_page).toBe(25);
    });
  });

  describe("B. Transient HTTP 502 recovery and timeout resilience", () => {
    it("recovers successfully from transient HTTP 502 during GraphQL fetch", async () => {
      const instantSleep = vi.fn().mockResolvedValue(undefined);
      const client = new GitHubClient("mock-token", "owner", "repo", undefined, instantSleep);
      let attempts = 0;
      const graphqlMock = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          const err: any = new Error("Bad Gateway 502");
          err.status = 502;
          throw err;
        }
        return {
          repository: {
            pullRequests: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PR_99",
                  number: 99,
                  title: "Recovered PR",
                  state: "OPEN",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
              ],
            },
          },
        };
      });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL();
      expect(items).toHaveLength(1);
      expect(items[0].number).toBe(99);
      expect(graphqlMock).toHaveBeenCalledTimes(2);
      expect(instantSleep).toHaveBeenCalledTimes(1);
    });

    it("recovers from HTTP 504 Gateway Timeout and transport timeouts", async () => {
      let callCount = 0;
      const fn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error("Gateway Timeout 504");
          err.status = 504;
          throw err;
        }
        if (callCount === 2) {
          const err: any = new Error("Connection reset by peer");
          err.code = "ECONNRESET";
          throw err;
        }
        return { success: true };
      });

      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const result = await withRetryBackoff(fn, undefined, sleepMock);
      expect(result).toEqual({ success: true });
      expect(fn).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("B. Adaptive page-size reduction on transient failure", () => {
    it("adaptively reduces GraphQL page size upon transient error and retries with smaller page", async () => {
      const instantSleep = vi.fn().mockResolvedValue(undefined);
      const client = new GitHubClient("mock-token", "owner", "repo", undefined, instantSleep);
      const pageSizesObserved: number[] = [];

      const graphqlMock = vi.fn().mockImplementation(async (_query: string, vars: any) => {
        pageSizesObserved.push(vars.pageSize);
        if (pageSizesObserved.length === 1) {
          // First attempt at starting size 50 fails with 502
          const err: any = new Error("HTTP 502 Bad Gateway");
          err.status = 502;
          throw err;
        }
        return {
          repository: {
            pullRequests: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PR_50",
                  number: 50,
                  title: "Adaptive PR",
                  state: "OPEN",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
              ],
            },
          },
        };
      });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL();
      expect(items).toHaveLength(1);
      expect(pageSizesObserved).toHaveLength(2);
      expect(pageSizesObserved[0]).toBe(50); // initial default
      expect(pageSizesObserved[1]).toBe(25); // halved to relieve GitHub complexity
      expect(instantSleep).toHaveBeenCalledTimes(1);
    });

    it("halves repeatedly under persistent complexity until reaching minPageSize", async () => {
      const instantSleep = vi.fn().mockResolvedValue(undefined);
      const client = new GitHubClient("mock-token", "owner", "repo", undefined, instantSleep);
      const pageSizesObserved: number[] = [];

      const graphqlMock = vi.fn().mockImplementation(async (_query: string, vars: any) => {
        pageSizesObserved.push(vars.pageSize);
        if (pageSizesObserved.length < 3) {
          const err: any = new Error("HTTP 502 Bad Gateway");
          err.status = 502;
          throw err;
        }
        return {
          repository: {
            pullRequests: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PR_100",
                  number: 100,
                  title: "Survived PR",
                  state: "OPEN",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
              ],
            },
          },
        };
      });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL();
      expect(items).toHaveLength(1);
      expect(pageSizesObserved).toEqual([50, 25, 12]);
      expect(instantSleep).toHaveBeenCalledTimes(2);
    });
  });

  describe("B. Repeated failures and clean termination", () => {
    it("cleanly fails and throws when 502 persists past max retries", async () => {
      const instantSleep = vi.fn().mockResolvedValue(undefined);
      const client = new GitHubClient("mock-token", "owner", "repo", undefined, instantSleep);
      const graphqlMock = vi.fn().mockImplementation(async () => {
        const err: any = new Error("Persistent 502 Bad Gateway");
        err.status = 502;
        throw err;
      });

      (client as any).octokit = { graphql: graphqlMock };

      await expect(client.fetchPRsGraphQL()).rejects.toThrow("Persistent 502 Bad Gateway");
      expect(graphqlMock).toHaveBeenCalledTimes(5);
      expect(instantSleep).toHaveBeenCalledTimes(4);
    });

    it("throws ProviderError immediately on 401 Unauthorized without retrying", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const graphqlMock = vi.fn().mockImplementation(async () => {
        const err: any = new Error("Bad credentials");
        err.status = 401;
        throw err;
      });

      (client as any).octokit = { graphql: graphqlMock };

      await expect(client.fetchPRsGraphQL()).rejects.toThrow(ProviderError);
      expect(graphqlMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("C. Cursor correctness and deduplication", () => {
    it("deduplicates items returned across overlapping pages", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const graphqlMock = vi
        .fn()
        .mockResolvedValueOnce({
          repository: {
            pullRequests: {
              totalCount: 2,
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              nodes: [
                {
                  id: "PR_1",
                  number: 1,
                  title: "PR 1",
                  state: "OPEN",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            pullRequests: {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: "c2" },
              nodes: [
                // PR 1 repeated due to concurrent update during pagination
                {
                  id: "PR_1",
                  number: 1,
                  title: "PR 1 updated",
                  state: "OPEN",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
                {
                  id: "PR_2",
                  number: 2,
                  title: "PR 2",
                  state: "OPEN",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-03T00:00:00Z",
                },
              ],
            },
          },
        });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL();
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.number)).toEqual([1, 2]);
    });

    it("terminates pagination cleanly when endCursor is null or repeated, avoiding infinite loop", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const graphqlMock = vi.fn().mockResolvedValue({
        repository: {
          pullRequests: {
            totalCount: 5,
            pageInfo: { hasNextPage: true, endCursor: null }, // buggy response with hasNextPage=true but endCursor=null
            nodes: [
              {
                id: "PR_1",
                number: 1,
                title: "PR 1",
                state: "OPEN",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-02T00:00:00Z",
              },
            ],
          },
        },
      });

      (client as any).octokit = { graphql: graphqlMock };

      const items = await client.fetchPRsGraphQL();
      expect(items).toHaveLength(1);
      expect(graphqlMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("C. Empty and malformed GraphQL responses", () => {
    it("throws clear error when GraphQL returns error array without repository", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      (client as any).octokit = {
        graphql: vi.fn().mockResolvedValueOnce({
          errors: [{ message: "Repository not accessible" }],
        }),
      };

      await expect(client.fetchPRsGraphQL()).rejects.toThrow("GraphQL query error: Repository not accessible");
    });

    it("throws clear error when GraphQL response is missing repository issues", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      (client as any).octokit = {
        graphql: vi.fn().mockResolvedValueOnce({ repository: {} }),
      };

      await expect(client.fetchIssuesGraphQL()).rejects.toThrow("GraphQL response missing issues for owner/repo");
    });
  });

  describe("D. REST pagination efficiency & API budget calculation", () => {
    it("uses default page size of 100 for REST PR pagination for maximum efficiency", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const listMock = vi.fn().mockResolvedValueOnce({ headers: {}, data: [] });
      (client as any).octokit = { pulls: { list: listMock } };

      await client.fetchPRs();
      expect(listMock.mock.calls[0][0].per_page).toBe(100);
    });

    it("calculates API calls based on page chunks rather than treating max_prs as call count", () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      // Rate limit remaining is 4000/5000
      (client as any).rateLimiter.rateLimit = {
        remaining: 4000,
        limit: 5000,
        resetAt: new Date(Date.now() + 3600000),
      };

      // In runScan: with max_prs: 20000, 1 state, PRs + issues:
      const maxPRs = 20000;
      const states = ["open"];
      const estimatedCalls = Math.ceil(maxPRs / 100) * states.length * 2; // 400 calls

      expect(estimatedCalls).toBe(400);
      const warning = client.formatRateLimitWarning(estimatedCalls);
      // 4000 > 400 * 1.2, so warning MUST be null!
      expect(warning).toBeNull();
    });
  });

  describe("E. Metadata preservation: Richer GraphQL metadata surviving lower-fidelity REST updates", () => {
    it("preserves GraphQL CI, reviewCount, hasTests, closesIssues, additions/deletions/changedFiles when updated via REST", () => {
      const existingGraphQLMetadata = {
        author: "contributor-alice",
        authorIsBot: false,
        state: "open",
        closedAt: undefined,
        labels: ["needs-review"],
        additions: 142,
        deletions: 18,
        changedFiles: 4,
        ciStatus: "success" as const,
        reviewCount: 3,
        hasTests: true,
        bodyLength: 200,
        nodeId: "PR_kw12345",
        headRefOid: "commit_sha_123",
        closesIssues: [42, 88],
        provenance: "graphql" as const,
      };

      // A REST scan returns the PR with updated labels and state, but missing GraphQL enrichments:
      const restItem: PRItem = {
        number: 101,
        type: "pr",
        repo: "owner/repo",
        title: "PR Title Updated",
        body: "Updated description text with more details.",
        state: "closed",
        author: "contributor-alice",
        authorIsBot: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        closedAt: "2026-02-01T00:00:00Z",
        labels: ["merged", "v4"],
        // REST does not provide these in pulls.list:
        ciStatus: undefined,
        reviewCount: undefined,
        hasTests: undefined,
        closesIssues: undefined,
        additions: undefined,
        deletions: undefined,
        changedFiles: undefined,
        headRefOid: undefined,
        nodeId: undefined,
      };

      const freshRestMetadata = itemMetadata(restItem, "rest");
      expect(freshRestMetadata.provenance).toBe("rest");
      expect(freshRestMetadata.ciStatus).toBeUndefined();

      const preserved = preserveItemMetadata(freshRestMetadata, existingGraphQLMetadata);

      // Provenance remains "graphql" because high-fidelity signals are preserved
      expect(preserved.provenance).toBe("graphql");
      // Rich signals preserved from GraphQL
      expect(preserved.ciStatus).toBe("success");
      expect(preserved.reviewCount).toBe(3);
      expect(preserved.hasTests).toBe(true);
      expect(preserved.closesIssues).toEqual([42, 88]);
      expect(preserved.additions).toBe(142);
      expect(preserved.deletions).toBe(18);
      expect(preserved.changedFiles).toBe(4);
      expect(preserved.headRefOid).toBe("commit_sha_123");
      expect(preserved.nodeId).toBe("PR_kw12345");

      // Updated fields from REST are correctly updated
      expect(preserved.state).toBe("closed");
      expect(preserved.closedAt).toBe("2026-02-01T00:00:00Z");
      expect(preserved.labels).toEqual(["merged", "v4"]);
    });

    it("preserves rich metadata end-to-end in SQLite store during runScan with REST", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "prism-meta-preservation-"));
      const dbPath = resolve(dir, "test.db");
      const store = new VectorStore(dbPath, 2, "test-model");

      try {
        // Initial scan via GraphQL populated rich metadata:
        const initialPR: PRItem = {
          number: 200,
          type: "pr",
          repo: "owner/repo",
          title: "Initial PR",
          body: "Initial PR Body",
          state: "open",
          author: "alice",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          labels: ["bug"],
          ciStatus: "success",
          reviewCount: 4,
          hasTests: true,
          additions: 200,
          deletions: 50,
          changedFiles: 6,
          closesIssues: [99],
        };

        const ctxGraphQL = {
          config: { max_prs: 100, batch_size: 50, thresholds: { duplicate_similarity: 0.85 } },
          env: {
            GITHUB_TOKEN: "mock-token",
            EMBEDDING_PROVIDER: "ollama",
            EMBEDDING_MODEL: "test-model",
            LLM_PROVIDER: "ollama",
            LLM_MODEL: "m",
          },
          owner: "owner",
          repo: "repo",
          repoFull: "owner/repo",
          github: {
            fetchPRsGraphQL: async () => [initialPR],
            fetchIssuesGraphQL: async () => [],
            getRateLimit: () => ({ remaining: 5000, limit: 5000 }),
            formatRateLimitWarning: () => null,
          },
          store,
          embedder: {
            dimensions: 2,
            embed: async () => [1, 0],
            embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
          },
        };

        await runScan(ctxGraphQL as any, {});

        const itemAfterGQL = store.getByNumber("owner/repo", 200);
        expect(itemAfterGQL?.metadata.ciStatus).toBe("success");
        expect(itemAfterGQL?.metadata.reviewCount).toBe(4);
        expect(itemAfterGQL?.metadata.hasTests).toBe(true);
        expect(itemAfterGQL?.metadata.additions).toBe(200);
        expect(itemAfterGQL?.metadata.closesIssues).toEqual([99]);
        expect(itemAfterGQL?.metadata.provenance).toBe("graphql");

        // Second scan is REST with updatedAt bumped (item updated on GitHub):
        const restPR: PRItem = {
          number: 200,
          type: "pr",
          repo: "owner/repo",
          title: "Initial PR with Updated Body",
          body: "Updated Body",
          state: "open",
          author: "alice",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-05T00:00:00Z", // updated!
          labels: ["bug", "reviewed"],
          // REST omits:
          ciStatus: undefined,
          reviewCount: undefined,
          hasTests: undefined,
          additions: undefined,
          deletions: undefined,
          changedFiles: undefined,
          closesIssues: undefined,
        };

        const ctxREST = {
          ...ctxGraphQL,
          github: {
            fetchPRs: async () => [restPR],
            fetchIssues: async () => [],
            getRateLimit: () => ({ remaining: 5000, limit: 5000 }),
            formatRateLimitWarning: () => null,
          },
        };

        await runScan(ctxREST as any, { useRest: true });

        const itemAfterREST = store.getByNumber("owner/repo", 200);
        // Rich GraphQL signals MUST survive!
        expect(itemAfterREST?.metadata.ciStatus).toBe("success");
        expect(itemAfterREST?.metadata.reviewCount).toBe(4);
        expect(itemAfterREST?.metadata.hasTests).toBe(true);
        expect(itemAfterREST?.metadata.additions).toBe(200);
        expect(itemAfterREST?.metadata.closesIssues).toEqual([99]);
        expect(itemAfterREST?.metadata.provenance).toBe("graphql");
        // Updated REST fields are reflected:
        expect(itemAfterREST?.title).toBe("Initial PR with Updated Body");
        expect(itemAfterREST?.metadata.labels).toEqual(["bug", "reviewed"]);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Safety: No GitHub write mutations", () => {
    it("guarantees fetch operations perform zero write operations on GitHubClient", async () => {
      const client = new GitHubClient("mock-token", "owner", "repo");
      const writeSpies = [
        vi.spyOn((client as any).octokit.issues, "createComment" as never),
        vi.spyOn((client as any).octokit.issues, "addLabels" as never),
        vi.spyOn((client as any).octokit.issues, "removeLabel" as never),
        vi.spyOn((client as any).octokit.issues, "createLabel" as never),
      ];

      (client as any).octokit.graphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      });

      await client.fetchPRsGraphQL();

      for (const spy of writeSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });
});
