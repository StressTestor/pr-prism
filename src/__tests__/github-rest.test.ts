import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../github.js";
import { createWriteGate } from "../write-gate.js";

describe("REST diff retrieval & caching", () => {
  it("fetches diff from API and caches it in store", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const mockDiff = "diff --git a/foo.ts b/foo.ts\n+hello world";
    const getMock = vi.fn().mockResolvedValue({
      headers: {},
      data: mockDiff,
    });

    (client as any).octokit = {
      pulls: { get: getMock },
    };

    const mockStore = {
      getCachedDiff: vi.fn().mockReturnValue(null),
      cacheDiff: vi.fn(),
    };

    const result = await client.fetchDiff(42, mockStore as any);

    expect(result).toBe(mockDiff);
    expect(getMock).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 42,
      mediaType: { format: "diff" },
    });
    expect(mockStore.getCachedDiff).toHaveBeenCalledWith("owner/repo", 42);
    expect(mockStore.cacheDiff).toHaveBeenCalledWith("owner/repo", 42, mockDiff);
  });

  it("returns cached diff immediately without calling Octokit", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const getMock = vi.fn();
    (client as any).octokit = {
      pulls: { get: getMock },
    };

    const mockStore = {
      getCachedDiff: vi.fn().mockReturnValue("cached diff content"),
      cacheDiff: vi.fn(),
    };

    const result = await client.fetchDiff(42, mockStore as any);

    expect(result).toBe("cached diff content");
    expect(mockStore.getCachedDiff).toHaveBeenCalledWith("owner/repo", 42);
    expect(getMock).not.toHaveBeenCalled();
    expect(mockStore.cacheDiff).not.toHaveBeenCalled();
  });

  it("truncates diff exceeding 500,000 characters", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const hugeDiff = "a".repeat(500_050);
    const getMock = vi.fn().mockResolvedValue({
      headers: {},
      data: hugeDiff,
    });

    (client as any).octokit = {
      pulls: { get: getMock },
    };

    const mockStore = {
      getCachedDiff: vi.fn().mockReturnValue(null),
      cacheDiff: vi.fn(),
    };

    const result = await client.fetchDiff(42, mockStore as any);

    expect(result).toContain("[TRUNCATED — diff exceeded 500KB]");
    expect(result.length).toBeLessThan(hugeDiff.length);
    expect(mockStore.cacheDiff).toHaveBeenCalledWith("owner/repo", 42, result);
  });
});

describe("REST CI status check", () => {
  it("returns 'unknown' when no check runs exist", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc1234" } } }) },
      checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
    };

    const status = await client.fetchCIStatus(10);
    expect(status).toBe("unknown");
  });

  it("returns 'pending' when any check run is incomplete", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc1234" } } }) },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "in_progress", conclusion: null },
            ],
          },
        }),
      },
    };

    const status = await client.fetchCIStatus(10);
    expect(status).toBe("pending");
  });

  it("returns 'success' when all check runs succeed", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc1234" } } }) },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "success" },
            ],
          },
        }),
      },
    };

    const status = await client.fetchCIStatus(10);
    expect(status).toBe("success");
  });

  it("returns 'failure' when any check run has failed", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc1234" } } }) },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            total_count: 2,
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "failure" },
            ],
          },
        }),
      },
    };

    const status = await client.fetchCIStatus(10);
    expect(status).toBe("failure");
  });

  it("returns 'unknown' if check API throws", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      pulls: { get: vi.fn().mockRejectedValue(new Error("API offline")) },
    };

    const status = await client.fetchCIStatus(10);
    expect(status).toBe("unknown");
  });
});

describe("REST file content, reviews & counts", () => {
  it("decodes base64 file content properly", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    const rawContent = "name: PR-Prism\nversion: 1.0.0";
    const base64Content = Buffer.from(rawContent, "utf-8").toString("base64");

    (client as any).octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: base64Content, encoding: "base64" },
        }),
      },
    };

    const content = await client.fetchFileContent("prism.config.yaml");
    expect(content).toBe(rawContent);
  });

  it("returns null when file content is not found or encoding is invalid", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(new Error("Not found")),
      },
    };

    const content = await client.fetchFileContent("missing.yaml");
    expect(content).toBeNull();
  });

  it("fetches review count and handles failures gracefully", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      pulls: {
        listReviews: vi
          .fn()
          .mockResolvedValueOnce({
            headers: {},
            data: [{ id: 1 }, { id: 2 }],
          })
          .mockRejectedValueOnce(new Error("error")),
      },
    };

    expect(await client.fetchReviewCount(1)).toBe(2);
    expect(await client.fetchReviewCount(2)).toBe(0);
  });

  it("fetches changed files list and handles failures gracefully", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      pulls: {
        listFiles: vi
          .fn()
          .mockResolvedValueOnce({
            headers: {},
            data: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
          })
          .mockRejectedValueOnce(new Error("error")),
      },
    };

    expect(await client.fetchChangedFiles(1)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await client.fetchChangedFiles(2)).toEqual([]);
  });

  it("fetches author merge count via REST search and handles failures", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      search: {
        issuesAndPullRequests: vi
          .fn()
          .mockResolvedValueOnce({
            headers: {},
            data: { total_count: 14 },
          })
          .mockRejectedValueOnce(new Error("rate limit")),
      },
    };

    expect(await client.getAuthorMergeCount("alice")).toBe(14);
    expect(await client.getAuthorMergeCount("bob")).toBe(0);
  });

  it("fetches a single PR via REST getPR", async () => {
    const client = new GitHubClient("token", "owner", "repo");
    (client as any).octokit = {
      pulls: {
        get: vi.fn().mockResolvedValue({
          headers: {},
          data: {
            number: 99,
            node_id: "PR_node_99",
            title: "Fix database pool",
            body: "Resolves connection leak",
            state: "closed",
            merged_at: "2026-03-01T12:00:00Z",
            user: { login: "db-expert", type: "User" },
            created_at: "2026-03-01T10:00:00Z",
            closed_at: "2026-03-01T12:00:00Z",
            updated_at: "2026-03-01T12:00:00Z",
            head: { sha: "deadbeef" },
            labels: [{ name: "bug" }],
            diff_url: "https://github.com/owner/repo/pull/99.diff",
            additions: 15,
            deletions: 5,
            changed_files: 2,
          },
        }),
      },
    };

    const pr = await client.getPR(99);
    expect(pr.number).toBe(99);
    expect(pr.state).toBe("merged");
    expect(pr.author).toBe("db-expert");
    expect(pr.authorIsBot).toBe(false);
    expect(pr.closedAt).toBe("2026-03-01T12:00:00Z");
    expect(pr.labels).toEqual(["bug"]);
    expect(pr.headRefOid).toBe("deadbeef");
  });
});

describe("REST label operations with write gate", () => {
  it("removeLabel calls octokit under apply gate and swallows 404", async () => {
    const client = new GitHubClient("token", "owner", "repo", createWriteGate("apply"));
    const removeMock = vi.fn().mockRejectedValue(new Error("Label not found"));
    (client as any).octokit = {
      issues: { removeLabel: removeMock },
    };

    await expect(client.removeLabel(5, "nonexistent")).resolves.toBeUndefined();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});
