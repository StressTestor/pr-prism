import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveEmbeddingConfigHash, embeddingConfigHash } from "../embeddings.js";
import { parseDuration, reEmbedStoredItems, runScan } from "../pipeline.js";
import { VectorStore } from "../store.js";
import type { PipelineContext, PRItem, StoreItem } from "../types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function scanItem(number: number, updatedAt = "2026-01-01T00:00:00.000Z"): PRItem {
  return {
    type: "issue",
    number,
    repo: "owner/repo",
    title: `Item ${number}`,
    body: "Body",
    author: "tester",
    state: "open",
    labels: [],
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ciStatus: "unknown",
    reviewCount: 0,
    hasTests: false,
    nodeId: `node-${number}`,
    headRefOid: "",
    diffUrl: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

function storedItem(item: PRItem): StoreItem {
  return {
    id: `${item.repo}:${item.type}:${item.number}`,
    type: item.type,
    number: item.number,
    repo: item.repo,
    title: item.title,
    bodySnippet: item.body,
    embedding: new Float32Array(512).fill(0.25),
    metadata: {},
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function scanContext(store: VectorStore, items: PRItem[], embedBatch = vi.fn()): PipelineContext {
  return {
    config: { max_prs: 10, batch_size: 10 } as PipelineContext["config"],
    env: {
      GITHUB_TOKEN: "",
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_MODEL: "text-embedding-3-small",
      EMBEDDING_DIMENSIONS: 512,
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "local",
    },
    owner: "owner",
    repo: "repo",
    repoFull: "owner/repo",
    github: {
      formatRateLimitWarning: vi.fn().mockReturnValue(null),
      fetchPRs: vi.fn().mockResolvedValue(items),
      fetchIssues: vi.fn().mockResolvedValue([]),
      getRateLimit: vi.fn().mockReturnValue({ remaining: 100, limit: 100 }),
    } as unknown as PipelineContext["github"],
    store,
    embedder: { dimensions: 512, embed: vi.fn(), embedBatch },
  };
}

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

describe.sequential("scan embedding configuration compatibility", () => {
  it("does not overwrite an incompatible stored hash when every fetched item is unchanged", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-scan-config-"));
    const store = new VectorStore(join(tempDir, "prism.db"), 512, "text-embedding-3-small");
    const existing = scanItem(1);
    const legacyHash = embeddingConfigHash("openai", "text-embedding-3-small", 512);
    store.upsert(storedItem(existing));
    store.setMeta("embedding_config_hash", legacyHash);
    const embedBatch = vi.fn();

    try {
      await expect(runScan(scanContext(store, [existing], embedBatch), { useRest: true })).rejects.toThrow(
        /Run `prism re-embed`.*`prism reset`/,
      );
      expect(store.getMeta("embedding_config_hash")).toBe(legacyHash);
      expect(embedBatch).not.toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not add new embeddings to a database with an incompatible vector identity", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-scan-config-"));
    const store = new VectorStore(join(tempDir, "prism.db"), 512, "text-embedding-3-small");
    const existing = scanItem(1);
    const added = scanItem(2);
    const legacyHash = embeddingConfigHash("openai", "text-embedding-3-small", 512);
    store.upsert(storedItem(existing));
    store.setMeta("embedding_config_hash", legacyHash);
    const embedBatch = vi.fn();

    try {
      await expect(runScan(scanContext(store, [existing, added], embedBatch), { useRest: true })).rejects.toThrow(
        /embedding configuration changed/,
      );
      expect(store.getMeta("embedding_config_hash")).toBe(legacyHash);
      expect(store.getByNumber("owner/repo", added.number)).toBeUndefined();
      expect(embedBatch).not.toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("re-embed configuration identity", () => {
  it("stores the provider-selected identity only after a complete re-embed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-reembed-config-"));
    const store = new VectorStore(join(tempDir, "prism.db"), 2);
    const item = scanItem(1);
    store.upsert({ ...storedItem(item), embedding: new Float32Array([1, 0]) });
    store.setMeta("embedding_config_hash", "openai:provider/custom-model:2:t2");
    const providerConfig = {
      provider: "openai",
      model: "provider/custom-model",
      baseUrl: "https://compatible.example/v1",
      dimensions: 2,
    };
    const embedBatch = vi.fn().mockResolvedValue([[0.5, 0.5]]);

    try {
      await reEmbedStoredItems(
        store,
        store.getAllItems("owner/repo"),
        { dimensions: 2, embed: vi.fn(), embedBatch },
        providerConfig,
        10,
      );

      expect(embedBatch).toHaveBeenCalledOnce();
      expect(store.getEmbedding("owner/repo:issue:1")).toEqual(new Float32Array([0.5, 0.5]));
      expect(store.getMeta("embedding_config_hash")).toBe(effectiveEmbeddingConfigHash(providerConfig, 2));
      expect(store.getMeta("embedding_config_hash")).toContain(":vprovider-selected-v1");
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
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

describe("runScan metadata refresh dirty check", () => {
  it("does not rewrite metadata when nothing drifted", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { resolve } = await import("node:path");
    const { VectorStore } = await import("../store.js");
    const { runScan } = await import("../pipeline.js");
    const { vi } = await import("vitest");

    const dir = resolve(tmpdir(), `prism-dirty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const store = new VectorStore(resolve(dir, "test.db"), 2, "test-model");

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
      ciStatus: "success" as const,
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
        embed: async () => [1, 0],
        embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
      },
    };

    const spy = vi.spyOn(store, "refreshMetadata");
    try {
      await runScan(ctx as any, {}); // first scan embeds + stores canonical metadata
      await runScan(ctx as any, {}); // identical data: unchanged, nothing drifted
      expect(spy).not.toHaveBeenCalled();

      // drift ciStatus; third scan must refresh exactly once
      fetched.ciStatus = "failure" as any;
      await runScan(ctx as any, {});
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
