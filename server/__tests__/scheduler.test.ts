import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatWeeklyDigest, getLastMonday } from "../scheduler.js";
import type { RepoDigestData } from "../scheduler.js";
import { getItemCountSince, listInstalledRepos, openRepoDB } from "../db.js";
import type { Cluster, ScoredPR } from "../../src/types.js";

function makeScoredPR(number: number, title: string): ScoredPR {
  return {
    number,
    type: "issue",
    repo: "test/repo",
    title,
    body: "",
    state: "open",
    author: "tester",
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    labels: [],
    score: 0.5,
    signals: {
      hasTests: 0,
      ciPassing: 0,
      diffSize: 0,
      authorHistory: 0,
      descriptionQuality: 0,
      reviewApprovals: 0,
      recency: 0,
    },
  };
}

function makeCluster(id: number, size: number, theme: string): Cluster {
  const items: ScoredPR[] = [];
  for (let i = 0; i < size; i++) {
    items.push(makeScoredPR(id * 100 + i, `item ${i} of cluster ${id}`));
  }
  return {
    id,
    items,
    bestPick: items[0],
    avgSimilarity: 0.88,
    theme,
  };
}

describe("getLastMonday", () => {
  it("returns Monday for a Monday", () => {
    // 2026-03-16 is a Monday
    const result = getLastMonday(new Date("2026-03-16T14:00:00Z"));
    expect(result).toBe("2026-03-16T00:00:00.000Z");
  });

  it("returns previous Monday for a Wednesday", () => {
    // 2026-03-18 is a Wednesday
    const result = getLastMonday(new Date("2026-03-18T10:00:00Z"));
    expect(result).toBe("2026-03-16T00:00:00.000Z");
  });

  it("returns previous Monday for a Sunday", () => {
    // 2026-03-15 is a Sunday
    const result = getLastMonday(new Date("2026-03-15T10:00:00Z"));
    expect(result).toBe("2026-03-09T00:00:00.000Z");
  });

  it("returns previous Monday for a Saturday", () => {
    // 2026-03-14 is a Saturday
    const result = getLastMonday(new Date("2026-03-14T23:59:00Z"));
    expect(result).toBe("2026-03-09T00:00:00.000Z");
  });
});

describe("formatWeeklyDigest", () => {
  it("returns no-activity message when zero new items", () => {
    const repos: RepoDigestData[] = [
      {
        owner: "test",
        repo: "repo",
        totalItems: 500,
        embeddingCount: 500,
        newItemsThisWeek: 0,
        clusterCount: 12,
        biggestClusters: [],
        autoClosed: 0,
      },
    ];

    const result = formatWeeklyDigest(repos, "2026-03-16T00:00:00.000Z");
    expect(result).toContain("no new items this week");
    expect(result).toContain("500 items indexed");
    expect(result).toContain("12 duplicate clusters");
    expect(result).toContain("pr-prism");
  });

  it("includes summary when there are new items", () => {
    const repos: RepoDigestData[] = [
      {
        owner: "test",
        repo: "repo",
        totalItems: 500,
        embeddingCount: 500,
        newItemsThisWeek: 15,
        clusterCount: 12,
        biggestClusters: [makeCluster(1, 5, "login bug")],
        autoClosed: 0,
      },
    ];

    const result = formatWeeklyDigest(repos, "2026-03-16T00:00:00.000Z");
    expect(result).toContain("**15** new items this week");
    expect(result).toContain("**500** total items indexed");
    expect(result).toContain("**12** duplicate clusters");
    expect(result).toContain("### test/repo");
    expect(result).toContain("login bug");
    expect(result).not.toContain("auto-closed");
  });

  it("includes auto-closed count when > 0", () => {
    const repos: RepoDigestData[] = [
      {
        owner: "test",
        repo: "repo",
        totalItems: 100,
        embeddingCount: 100,
        newItemsThisWeek: 5,
        clusterCount: 3,
        biggestClusters: [],
        autoClosed: 2,
      },
    ];

    const result = formatWeeklyDigest(repos, "2026-03-16T00:00:00.000Z");
    expect(result).toContain("**2** items auto-closed");
    expect(result).toContain("auto-closed: **2**");
  });

  it("handles multiple repos", () => {
    const repos: RepoDigestData[] = [
      {
        owner: "org",
        repo: "frontend",
        totalItems: 200,
        embeddingCount: 200,
        newItemsThisWeek: 10,
        clusterCount: 5,
        biggestClusters: [],
        autoClosed: 0,
      },
      {
        owner: "org",
        repo: "backend",
        totalItems: 300,
        embeddingCount: 300,
        newItemsThisWeek: 8,
        clusterCount: 7,
        biggestClusters: [],
        autoClosed: 0,
      },
    ];

    const result = formatWeeklyDigest(repos, "2026-03-16T00:00:00.000Z");
    expect(result).toContain("**18** new items this week");
    expect(result).toContain("**500** total items indexed");
    expect(result).toContain("### org/frontend");
    expect(result).toContain("### org/backend");
  });

  it("shows biggest clusters table", () => {
    const clusters = [
      makeCluster(1, 8, "memory leak in worker"),
      makeCluster(2, 5, "auth timeout"),
      makeCluster(3, 3, "typo in docs"),
    ];

    const repos: RepoDigestData[] = [
      {
        owner: "test",
        repo: "repo",
        totalItems: 100,
        embeddingCount: 100,
        newItemsThisWeek: 5,
        clusterCount: 3,
        biggestClusters: clusters,
        autoClosed: 0,
      },
    ];

    const result = formatWeeklyDigest(repos, "2026-03-16T00:00:00.000Z");
    expect(result).toContain("biggest unresolved clusters");
    expect(result).toContain("memory leak in worker");
    expect(result).toContain("auth timeout");
    expect(result).toContain("88.0%");
  });
});

describe("listInstalledRepos", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs.length = 0;
  });

  it("returns empty for nonexistent dir", () => {
    const result = listInstalledRepos("/tmp/definitely-does-not-exist-abc123");
    expect(result).toEqual([]);
  });

  it("returns empty for empty dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-list-test-"));
    tmpDirs.push(dir);
    const result = listInstalledRepos(dir);
    expect(result).toEqual([]);
  });

  it("discovers repos with prism.db", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-list-test-"));
    tmpDirs.push(dir);

    // create a repo DB
    const store = openRepoDB(dir, "octocat", "hello-world", 4);
    store.close();

    const result = listInstalledRepos(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("ignores directories without prism.db", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-list-test-"));
    tmpDirs.push(dir);

    // create a directory that looks like a repo but has no DB
    mkdirSync(join(dir, "fake-repo"), { recursive: true });

    // create a real repo DB
    const store = openRepoDB(dir, "real", "repo", 4);
    store.close();

    const result = listInstalledRepos(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ owner: "real", repo: "repo" });
  });
});

describe("getItemCountSince", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs.length = 0;
  });

  it("returns 0 for nonexistent DB", () => {
    const result = getItemCountSince("/tmp/nope", "ghost", "missing", "2026-01-01T00:00:00Z");
    expect(result).toBe(0);
  });

  it("counts items created after the given date", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-since-test-"));
    tmpDirs.push(dir);

    const store = openRepoDB(dir, "test", "repo", 4);
    // insert items with different created_at dates
    const embedding = new Float32Array([1, 0, 0, 0]);

    store.upsert({
      id: "test/repo:issue:1",
      type: "issue",
      number: 1,
      repo: "test/repo",
      title: "old item",
      bodySnippet: "",
      embedding,
      metadata: {},
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    });

    store.upsert({
      id: "test/repo:issue:2",
      type: "issue",
      number: 2,
      repo: "test/repo",
      title: "new item",
      bodySnippet: "",
      embedding,
      metadata: {},
      createdAt: "2026-03-17T00:00:00Z",
      updatedAt: "2026-03-17T00:00:00Z",
    });

    store.upsert({
      id: "test/repo:issue:3",
      type: "issue",
      number: 3,
      repo: "test/repo",
      title: "newer item",
      bodySnippet: "",
      embedding,
      metadata: {},
      createdAt: "2026-03-18T12:00:00Z",
      updatedAt: "2026-03-18T12:00:00Z",
    });

    store.close();

    // items since March 16 should include #2 and #3
    const count = getItemCountSince(dir, "test", "repo", "2026-03-16T00:00:00Z");
    expect(count).toBe(2);

    // items since March 18 should include only #3
    const count2 = getItemCountSince(dir, "test", "repo", "2026-03-18T00:00:00Z");
    expect(count2).toBe(1);

    // items since March 20 should be 0
    const count3 = getItemCountSince(dir, "test", "repo", "2026-03-20T00:00:00Z");
    expect(count3).toBe(0);
  });
});
