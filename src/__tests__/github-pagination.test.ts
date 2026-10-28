import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../github.js";

describe("GraphQL pagination", () => {
  it("paginates pull requests across cursors until hasNextPage is false", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const graphqlMock = vi
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequests: {
            totalCount: 2,
            pageInfo: { hasNextPage: true, endCursor: "cursor_1" },
            nodes: [
              {
                id: "PR_1",
                number: 1,
                title: "PR 1",
                body: "Body 1",
                state: "OPEN",
                author: { login: "alice" },
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-02T00:00:00Z",
                labels: { nodes: [] },
                files: { totalCount: 1, nodes: [{ path: "index.ts" }] },
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequests: {
            totalCount: 2,
            pageInfo: { hasNextPage: false, endCursor: "cursor_2" },
            nodes: [
              {
                id: "PR_2",
                number: 2,
                title: "PR 2",
                body: "Body 2",
                state: "OPEN",
                author: { login: "bob" },
                createdAt: "2026-01-03T00:00:00Z",
                updatedAt: "2026-01-04T00:00:00Z",
                labels: { nodes: [] },
                files: { totalCount: 1, nodes: [{ path: "test.spec.ts" }] },
              },
            ],
          },
        },
      });

    (client as any).octokit = { graphql: graphqlMock };

    const items = await client.fetchPRsGraphQL();

    expect(items).toHaveLength(2);
    expect(items[0].number).toBe(1);
    expect(items[1].number).toBe(2);
    expect(graphqlMock).toHaveBeenCalledTimes(2);
    expect(graphqlMock.mock.calls[0][1].cursor).toBeNull();
    expect(graphqlMock.mock.calls[1][1].cursor).toBe("cursor_1");
  });

  it("stops GraphQL PR pagination early when maxItems is reached", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const graphqlMock = vi.fn().mockResolvedValue({
      repository: {
        pullRequests: {
          totalCount: 10,
          pageInfo: { hasNextPage: true, endCursor: "cursor_next" },
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

    const items = await client.fetchPRsGraphQL({ maxItems: 1 });
    expect(items).toHaveLength(1);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
  });

  it("stops GraphQL PR pagination early when updatedAt is older than since", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const onProgress = vi.fn();
    const graphqlMock = vi.fn().mockResolvedValue({
      repository: {
        pullRequests: {
          totalCount: 5,
          pageInfo: { hasNextPage: true, endCursor: "cursor_1" },
          nodes: [
            {
              id: "PR_1",
              number: 1,
              title: "PR 1",
              state: "OPEN",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-05T00:00:00Z",
            },
            {
              id: "PR_2",
              number: 2,
              title: "PR 2",
              state: "OPEN",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2025-12-01T00:00:00Z", // older than since
            },
          ],
        },
      },
    });

    (client as any).octokit = { graphql: graphqlMock };

    const items = await client.fetchPRsGraphQL({ since: "2026-01-01T00:00:00Z", onProgress });
    expect(items).toHaveLength(1);
    expect(items[0].number).toBe(1);
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it("paginates issues across GraphQL pages and stops when hasNextPage is false", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const graphqlMock = vi
      .fn()
      .mockResolvedValueOnce({
        repository: {
          issues: {
            totalCount: 2,
            pageInfo: { hasNextPage: true, endCursor: "issue_cursor_1" },
            nodes: [
              {
                id: "ISSUE_1",
                number: 10,
                title: "Issue 10",
                state: "OPEN",
                author: { login: "alice" },
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-02T00:00:00Z",
                labels: { nodes: [] },
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          issues: {
            totalCount: 2,
            pageInfo: { hasNextPage: false, endCursor: "issue_cursor_2" },
            nodes: [
              {
                id: "ISSUE_2",
                number: 11,
                title: "Issue 11",
                state: "CLOSED",
                author: { login: "bob" },
                createdAt: "2026-01-03T00:00:00Z",
                updatedAt: "2026-01-04T00:00:00Z",
                labels: { nodes: [] },
              },
            ],
          },
        },
      });

    (client as any).octokit = { graphql: graphqlMock };

    const items = await client.fetchIssuesGraphQL({ state: "all" });
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("issue");
    expect(items[0].number).toBe(10);
    expect(items[1].number).toBe(11);
    expect(graphqlMock).toHaveBeenCalledTimes(2);
  });
});

describe("REST pagination", () => {
  it("paginates PRs with page numbers until an empty page is returned", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const listMock = vi
      .fn()
      .mockResolvedValueOnce({
        headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1700000000" },
        data: [
          {
            number: 101,
            title: "PR 101",
            state: "open",
            user: { login: "alice" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            labels: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        headers: {},
        data: [
          {
            number: 102,
            title: "PR 102",
            state: "closed",
            merged_at: "2026-01-03T00:00:00Z",
            user: { login: "bob" },
            created_at: "2026-01-02T00:00:00Z",
            updated_at: "2026-01-03T00:00:00Z",
            labels: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        headers: {},
        data: [],
      });

    (client as any).octokit = {
      pulls: { list: listMock },
    };

    const items = await client.fetchPRs({ batchSize: 50 });
    expect(items).toHaveLength(2);
    expect(items[0].number).toBe(101);
    expect(items[1].number).toBe(102);
    expect(items[1].state).toBe("merged");
    expect(listMock).toHaveBeenCalledTimes(3);
    expect(listMock.mock.calls[0][0].page).toBe(1);
    expect(listMock.mock.calls[1][0].page).toBe(2);
    expect(listMock.mock.calls[2][0].page).toBe(3);
  });

  it("filters out pull requests when fetching issues via REST", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const listForRepoMock = vi
      .fn()
      .mockResolvedValueOnce({
        headers: {},
        data: [
          {
            number: 201,
            title: "Real issue",
            state: "open",
            user: { login: "alice" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            labels: [],
          },
          {
            number: 202,
            title: "PR masquerading as issue",
            pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/202" },
            state: "open",
            user: { login: "bob" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            labels: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        headers: {},
        data: [],
      });

    (client as any).octokit = {
      issues: { listForRepo: listForRepoMock },
    };

    const items = await client.fetchIssues();
    expect(items).toHaveLength(1);
    expect(items[0].number).toBe(201);
    expect(items[0].type).toBe("issue");
  });

  it("stops REST pagination early when updatedAt is older than since", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const listMock = vi.fn().mockResolvedValueOnce({
      headers: {},
      data: [
        {
          number: 301,
          title: "Recent PR",
          state: "open",
          user: { login: "alice" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-05T00:00:00Z",
          labels: [],
        },
        {
          number: 302,
          title: "Old PR",
          state: "open",
          user: { login: "bob" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2025-11-01T00:00:00Z", // before since
          labels: [],
        },
      ],
    });

    (client as any).octokit = {
      pulls: { list: listMock },
    };

    const items = await client.fetchPRs({ since: "2026-01-01T00:00:00Z" });
    expect(items).toHaveLength(1);
    expect(items[0].number).toBe(301);
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});
