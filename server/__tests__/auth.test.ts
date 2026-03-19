import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTokenCache,
  closeIssue,
  createIssue,
  fetchFileContent,
  getInstallationOctokit,
  getTokenCache,
  postComment,
} from "../auth.js";

// --- mock @octokit/auth-app and @octokit/rest ---

// Track Octokit instances and their auth values
const mockCreateComment = vi.fn().mockResolvedValue({});
const mockIssuesUpdate = vi.fn().mockResolvedValue({});
const mockIssuesCreate = vi.fn().mockResolvedValue({ data: { number: 77 } });
const mockGetContent = vi.fn();
const mockCreateInstallationAccessToken = vi.fn();

vi.mock("@octokit/rest", () => {
  return {
    Octokit: vi.fn().mockImplementation((opts?: Record<string, unknown>) => ({
      _auth: opts?.auth,
      _authStrategy: opts?.authStrategy,
      rest: {
        apps: {
          createInstallationAccessToken: mockCreateInstallationAccessToken,
        },
        issues: {
          createComment: mockCreateComment,
          update: mockIssuesUpdate,
          create: mockIssuesCreate,
        },
        repos: {
          getContent: mockGetContent,
        },
      },
    })),
  };
});

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(),
}));

beforeEach(() => {
  clearTokenCache();
  vi.clearAllMocks();
});

// --- getInstallationOctokit ---

describe("getInstallationOctokit", () => {
  it("creates an installation token and caches it", async () => {
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    mockCreateInstallationAccessToken.mockResolvedValueOnce({
      data: { token: "ghs_test123", expires_at: futureDate },
    });

    const octokit = await getInstallationOctokit("12345", "fake-key", 9999);
    expect(octokit).toBeDefined();
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 9999,
    });

    // token should be in cache
    const cache = getTokenCache();
    expect(cache.has(9999)).toBe(true);
    expect(cache.get(9999)!.token).toBe("ghs_test123");
  });

  it("returns cached token on subsequent calls", async () => {
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    mockCreateInstallationAccessToken.mockResolvedValueOnce({
      data: { token: "ghs_cached", expires_at: futureDate },
    });

    // first call — creates token
    await getInstallationOctokit("12345", "fake-key", 8888);
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(1);

    // second call — should use cache, not call API again
    await getInstallationOctokit("12345", "fake-key", 8888);
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes expired tokens", async () => {
    // seed cache with an expired token
    const pastDate = new Date(Date.now() - 60_000);
    getTokenCache().set(7777, { token: "ghs_old", expiresAt: pastDate });

    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    mockCreateInstallationAccessToken.mockResolvedValueOnce({
      data: { token: "ghs_refreshed", expires_at: futureDate },
    });

    await getInstallationOctokit("12345", "fake-key", 7777);
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(1);
    expect(getTokenCache().get(7777)!.token).toBe("ghs_refreshed");
  });

  it("caches different installation IDs separately", async () => {
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    mockCreateInstallationAccessToken
      .mockResolvedValueOnce({
        data: { token: "ghs_aaa", expires_at: futureDate },
      })
      .mockResolvedValueOnce({
        data: { token: "ghs_bbb", expires_at: futureDate },
      });

    await getInstallationOctokit("12345", "fake-key", 1111);
    await getInstallationOctokit("12345", "fake-key", 2222);

    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(2);
    expect(getTokenCache().get(1111)!.token).toBe("ghs_aaa");
    expect(getTokenCache().get(2222)!.token).toBe("ghs_bbb");
  });
});

// --- postComment ---

describe("postComment", () => {
  it("calls issues.createComment with correct params", async () => {
    const octokit = { rest: { issues: { createComment: mockCreateComment } } } as any;
    await postComment(octokit, "octocat", "my-repo", 42, "duplicate of #10");

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "my-repo",
      issue_number: 42,
      body: "duplicate of #10",
    });
  });
});

// --- closeIssue ---

describe("closeIssue", () => {
  it("calls issues.update with state closed and not_planned reason", async () => {
    const octokit = { rest: { issues: { update: mockIssuesUpdate } } } as any;
    await closeIssue(octokit, "octocat", "my-repo", 42);

    expect(mockIssuesUpdate).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "my-repo",
      issue_number: 42,
      state: "closed",
      state_reason: "not_planned",
    });
  });
});

// --- createIssue ---

describe("createIssue", () => {
  it("calls issues.create and returns the issue number", async () => {
    mockIssuesCreate.mockResolvedValueOnce({ data: { number: 55 } });
    const octokit = { rest: { issues: { create: mockIssuesCreate } } } as any;
    const num = await createIssue(octokit, "octocat", "my-repo", "triage report", "body here");

    expect(mockIssuesCreate).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "my-repo",
      title: "triage report",
      body: "body here",
    });
    expect(num).toBe(55);
  });
});

// --- fetchFileContent ---

describe("fetchFileContent", () => {
  it("decodes base64 content from the API response", async () => {
    const encoded = Buffer.from("# CODEOWNERS\n* @octocat").toString("base64");
    mockGetContent.mockResolvedValueOnce({
      data: { content: encoded, encoding: "base64" },
    });

    const octokit = { rest: { repos: { getContent: mockGetContent } } } as any;
    const result = await fetchFileContent(octokit, "octocat", "my-repo", ".github/CODEOWNERS");

    expect(mockGetContent).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "my-repo",
      path: ".github/CODEOWNERS",
    });
    expect(result).toBe("# CODEOWNERS\n* @octocat");
  });

  it("returns null when file does not exist (404)", async () => {
    mockGetContent.mockRejectedValueOnce(new Error("Not Found"));

    const octokit = { rest: { repos: { getContent: mockGetContent } } } as any;
    const result = await fetchFileContent(octokit, "octocat", "my-repo", "CODEOWNERS");

    expect(result).toBeNull();
  });

  it("returns null for directory responses (no content field)", async () => {
    mockGetContent.mockResolvedValueOnce({
      data: [{ name: "file.txt", type: "file" }],
    });

    const octokit = { rest: { repos: { getContent: mockGetContent } } } as any;
    const result = await fetchFileContent(octokit, "octocat", "my-repo", "src");

    expect(result).toBeNull();
  });
});
