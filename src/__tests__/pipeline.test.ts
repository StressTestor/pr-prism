import { describe, expect, it } from "vitest";
import { parseDuration } from "../pipeline.js";

describe("parseDuration", () => {
  it("parses days", () => {
    const result = parseDuration("7d");
    const date = new Date(result);
    const expected = new Date();
    expected.setDate(expected.getDate() - 7);
    expect(Math.abs(date.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("parses weeks", () => {
    const result = parseDuration("2w");
    const date = new Date(result);
    const expected = new Date();
    expected.setDate(expected.getDate() - 14);
    expect(Math.abs(date.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("parses months", () => {
    const result = parseDuration("1m");
    const date = new Date(result);
    const expected = new Date();
    expected.setDate(expected.getDate() - 30);
    expect(Math.abs(date.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
    expect(() => parseDuration("7x")).toThrow("Invalid duration");
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });
});

describe("pipeline exports", () => {
  it("exports key pipeline functions", async () => {
    const mod = await import("../pipeline.js");
    expect(typeof mod.createPipelineContext).toBe("function");
    expect(typeof mod.runScan).toBe("function");
    expect(typeof mod.runDupes).toBe("function");
    expect(typeof mod.runRank).toBe("function");
    expect(typeof mod.runVision).toBe("function");
    expect(typeof mod.runCompare).toBe("function");
    expect(typeof mod.resolveRepos).toBe("function");
  });
});

describe("runScan metadata refresh for unchanged items", () => {
  it("refreshes drifting metadata (closesIssues, ciStatus) without re-embedding", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { resolve } = await import("node:path");
    const { VectorStore } = await import("../store.js");
    const { runScan } = await import("../pipeline.js");

    const dir = resolve(tmpdir(), `prism-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const store = new VectorStore(resolve(dir, "test.db"), 2, "test-model");

    // Legacy row: scanned before closesIssues existed, CI was green back then.
    store.upsert({
      id: "owner/repo:pr:10",
      type: "pr",
      number: 10,
      repo: "owner/repo",
      title: "a pr",
      bodySnippet: "body",
      embedding: new Float32Array([1, 0]),
      metadata: { author: "dev", state: "open", labels: [], ciStatus: "success" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });

    // Same updatedAt (unchanged item), but drifted CI + newly-scanned closing refs.
    const fetched = {
      number: 10,
      type: "pr" as const,
      repo: "owner/repo",
      title: "a pr",
      body: "body",
      state: "open",
      author: "dev",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      labels: [],
      ciStatus: "failure" as const,
      closesIssues: [7],
    };

    const ctx = {
      config: { max_prs: 100, batch_size: 50, thresholds: { duplicate_similarity: 0.85 } },
      env: {
        GITHUB_TOKEN: "t",
        EMBEDDING_PROVIDER: "ollama",
        EMBEDDING_MODEL: "test-model",
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "m",
      },
      owner: "owner",
      repo: "repo",
      repoFull: "owner/repo",
      github: {
        fetchPRsGraphQL: async () => [fetched],
        fetchIssuesGraphQL: async () => [],
        getRateLimit: () => ({ remaining: 5000, limit: 5000 }),
      },
      store,
      embedder: {
        dimensions: 2,
        embed: async () => {
          throw new Error("unchanged item must not be re-embedded");
        },
        embedBatch: async () => {
          throw new Error("unchanged item must not be re-embedded");
        },
      },
    };

    try {
      await runScan(ctx as any, {});
      const item = store.getAllItems("owner/repo")[0] as any;
      expect(item.closesIssues).toEqual([7]);
      expect(item.ciStatus).toBe("failure");
      expect(store.getEmbedding("owner/repo:pr:10")).toEqual(new Float32Array([1, 0]));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
