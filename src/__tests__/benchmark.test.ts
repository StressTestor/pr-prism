import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  benchmarkDatabasePath,
  computeClusterOverlap,
  ensureBenchmarkModels,
  resolveBenchmarkProviderConfig,
  runBenchmarkForModel,
} from "../benchmark.js";
import { VectorStore } from "../store.js";
import type { PRItem } from "../types.js";

interface SimpleCluster {
  id: number;
  items: number[];
}

function benchmarkItem(number = 1): PRItem {
  return {
    type: "issue",
    number,
    repo: "owner/repo",
    title: `Synthetic benchmark item ${number}`,
    body: "Short body",
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
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function embeddingResponse(embeddings: number[][], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data: embeddings.map((embedding, index) => ({ index, embedding })) }),
    text: () => Promise.resolve(status === 401 ? "unauthorized" : ""),
  };
}

describe("computeClusterOverlap", () => {
  it("returns 100% for identical clusters", () => {
    const a: SimpleCluster[] = [
      { id: 1, items: [1, 2, 3] },
      { id: 2, items: [4, 5] },
    ];
    const b: SimpleCluster[] = [
      { id: 1, items: [1, 2, 3] },
      { id: 2, items: [4, 5] },
    ];
    const result = computeClusterOverlap(a, b);
    expect(result.overlapPercent).toBe(100);
    expect(result.uniqueToA).toBe(0);
    expect(result.uniqueToB).toBe(0);
  });

  it("returns 0% for completely disjoint clusters", () => {
    const a: SimpleCluster[] = [{ id: 1, items: [1, 2, 3] }];
    const b: SimpleCluster[] = [{ id: 1, items: [4, 5, 6] }];
    const result = computeClusterOverlap(a, b);
    expect(result.overlapPercent).toBe(0);
  });

  it("handles partial overlap", () => {
    const a: SimpleCluster[] = [{ id: 1, items: [1, 2, 3, 4] }];
    const b: SimpleCluster[] = [{ id: 1, items: [2, 3, 4, 5] }];
    const result = computeClusterOverlap(a, b);
    // Jaccard: intersection{2,3,4}=3, union{1,2,3,4,5}=5 -> 60%
    expect(result.overlapPercent).toBe(60);
  });

  it("handles different cluster counts", () => {
    const a: SimpleCluster[] = [
      { id: 1, items: [1, 2] },
      { id: 2, items: [3, 4] },
      { id: 3, items: [5, 6] },
    ];
    const b: SimpleCluster[] = [{ id: 1, items: [1, 2, 3, 4] }];
    const result = computeClusterOverlap(a, b);
    expect(result.uniqueToA).toBeGreaterThan(0);
  });

  it("handles empty input (0 clusters both sides)", () => {
    const result = computeClusterOverlap([], []);
    expect(result.overlapPercent).toBe(100);
    expect(result.uniqueToA).toBe(0);
    expect(result.uniqueToB).toBe(0);
  });

  it("handles one side empty", () => {
    const a: SimpleCluster[] = [{ id: 1, items: [1, 2, 3] }];
    const result = computeClusterOverlap(a, []);
    expect(result.overlapPercent).toBe(0);
    expect(result.uniqueToA).toBe(1);
    expect(result.uniqueToB).toBe(0);
  });
});

describe.sequential("benchmark provider selection", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps an implicit benchmark on plain Ollama even when cloud environment values are populated", () => {
    const config = resolveBenchmarkProviderConfig(
      {},
      {
        EMBEDDING_API_KEY: "cloud-key",
        EMBEDDING_BASE_URL: "https://cloud.example/v1",
        EMBEDDING_DIMENSIONS: 1024,
      },
    );
    expect(config.provider).toBe("ollama");
    expect(config.baseUrl).toBeUndefined();
    expect(config.dimensions).toBeUndefined();
  });

  it("inherits cloud environment values only for an explicitly selected OpenAI provider", () => {
    const config = resolveBenchmarkProviderConfig(
      { provider: "openai" },
      {
        EMBEDDING_API_KEY: "cloud-key",
        EMBEDDING_BASE_URL: "https://cloud.example/v1/",
        EMBEDDING_DIMENSIONS: 1024,
      },
    );
    expect(config).toEqual({
      provider: "openai",
      apiKey: "cloud-key",
      baseUrl: "https://cloud.example/v1",
      dimensions: 1024,
    });
  });

  it("prefers explicit benchmark URL and dimensions over OpenAI environment values", () => {
    const config = resolveBenchmarkProviderConfig(
      { provider: "openai", baseUrl: "https://cli.example/v2/", dimensions: 512 },
      {
        EMBEDDING_API_KEY: "cloud-key",
        EMBEDDING_BASE_URL: "https://environment.example/v1",
        EMBEDDING_DIMENSIONS: 1024,
      },
    );
    expect(config.baseUrl).toBe("https://cli.example/v2");
    expect(config.dimensions).toBe(512);
  });

  it("does not retain explicit cloud configuration in a later implicit Ollama resolution", () => {
    const env = {
      EMBEDDING_API_KEY: "cloud-key",
      EMBEDDING_BASE_URL: "https://cloud.example/v1",
      EMBEDDING_DIMENSIONS: 1024,
    };
    expect(resolveBenchmarkProviderConfig({ provider: "openai" }, env).provider).toBe("openai");
    expect(resolveBenchmarkProviderConfig({}, env)).toMatchObject({
      provider: "ollama",
      baseUrl: undefined,
      dimensions: undefined,
    });
  });

  it.each(["kimi", "jina", "voyageai"])("does not pass OpenAI environment settings to %s", (provider) => {
    const config = resolveBenchmarkProviderConfig(
      { provider },
      {
        EMBEDDING_API_KEY: "cloud-key",
        EMBEDDING_BASE_URL: "https://cloud.example/v1",
        EMBEDDING_DIMENSIONS: 1024,
      },
    );
    expect(config.baseUrl).toBeUndefined();
    expect(config.dimensions).toBeUndefined();
  });

  it("checks models for Ollama and skips checks for cloud providers", async () => {
    const ensureModel = vi.fn().mockResolvedValue(undefined);
    await ensureBenchmarkModels("openai", ["cloud-a", "cloud-b"], ensureModel);
    expect(ensureModel).not.toHaveBeenCalled();

    await ensureBenchmarkModels("ollama", ["local-a", "local-b"], ensureModel);
    expect(ensureModel).toHaveBeenCalledTimes(2);
  });

  it("forwards cloud provider configuration through the normal factory without persisting credentials or a raw URL", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-benchmark-"));
    mkdirSync(join(tempDir, "data"));
    process.chdir(tempDir);

    let requestUrl = "";
    let requestAuthorization = "";
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: any) => {
        requestUrl = url;
        requestAuthorization = init.headers.Authorization;
        requestBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ index: 0, embedding: [1, 0] }] }),
          text: () => Promise.resolve(""),
        };
      }),
    );

    const item = benchmarkItem();
    const apiKey = "benchmark-cloud-secret";
    const baseUrl = "https://compatible.example/v1";

    const result = await runBenchmarkForModel("provider/model", "owner/repo", [0.85], [item], {
      provider: "openai",
      apiKey,
      baseUrl,
      dimensions: 2,
    });

    expect(requestUrl).toBe("https://compatible.example/v1/embeddings");
    expect(requestAuthorization).toBe(`Bearer ${apiKey}`);
    expect(requestBody.dimensions).toBe(2);
    expect(result.provider).toBe("openai");
    expect(result.dimensions).toBe(2);
    expect(result.endpointFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(baseUrl);

    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("distinguishes generated database names by provider and effective dimensions", () => {
    const openai = basename(benchmarkDatabasePath("owner/repo", "openai", "provider/model", 1024));
    const ollama = basename(benchmarkDatabasePath("owner/repo", "ollama", "provider/model", 768));
    expect(openai).toContain("openai");
    expect(openai).toContain("1024d");
    expect(ollama).toContain("ollama");
    expect(ollama).toContain("768d");
    expect(openai).not.toBe(ollama);
  });

  it("adds only a normalized endpoint fingerprint to custom-endpoint database names", () => {
    const legacy = basename(benchmarkDatabasePath("owner/repo", "openai", "provider/model", 1024));
    const first = basename(
      benchmarkDatabasePath("owner/repo", "openai", "provider/model", 1024, {
        baseUrl: "https://user:password@first.example/v1/?secret=query#fragment",
      }),
    );
    const equivalent = basename(
      benchmarkDatabasePath("owner/repo", "openai", "provider/model", 1024, {
        baseUrl: "https://first.example/v1",
      }),
    );
    const differentOrigin = basename(
      benchmarkDatabasePath("owner/repo", "openai", "provider/model", 1024, {
        baseUrl: "https://second.example/v1",
      }),
    );
    const differentPath = basename(
      benchmarkDatabasePath("owner/repo", "openai", "provider/model", 1024, {
        baseUrl: "https://first.example/v2",
      }),
    );

    expect(legacy).toBe("benchmark-owner-repo-openai-provider-model-1024d.db");
    expect(first).toBe(equivalent);
    expect(first).toMatch(/-e[a-f0-9]{16}\.db$/);
    expect(first).not.toBe(differentOrigin);
    expect(first).not.toBe(differentPath);
    expect(first).not.toMatch(/first|user|password|secret|query|fragment/);
  });

  async function expectCloudFailure(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-benchmark-failure-"));
    mkdirSync(join(tempDir, "data"));
    process.chdir(tempDir);
    const baseUrl = "https://compatible.example/v1";
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        runBenchmarkForModel("provider/model", "owner/repo", [0.85], [benchmarkItem()], {
          provider: "openai",
          apiKey: "cloud-key",
          baseUrl,
          dimensions: 2,
        }),
      ).rejects.toBeDefined();
      expect(fetchMock).toHaveBeenCalledOnce();

      const dbPath = benchmarkDatabasePath("owner/repo", "openai", "provider/model", 2, { baseUrl });
      expect(existsSync(dbPath)).toBe(true);
      const store = new VectorStore(dbPath);
      expect(store.getAllEmbeddings("owner/repo").size).toBe(0);
      store.close();
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it("aborts a cloud model run on HTTP 401 without individual retries or zero vectors", async () => {
    await expectCloudFailure(vi.fn().mockResolvedValue(embeddingResponse([], 401)));
  });

  it("aborts a cloud model run on a rejected fetch without individual retries or zero vectors", async () => {
    await expectCloudFailure(vi.fn().mockRejectedValue(new Error("network unavailable")));
  });

  it("aborts a cloud model run on invalid vector dimensions without individual retries or zero vectors", async () => {
    await expectCloudFailure(vi.fn().mockResolvedValue(embeddingResponse([[1]])));
  });

  it("preserves Ollama's individual truncated-text fallback", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-benchmark-ollama-"));
    mkdirSync(join(tempDir, "data"));
    process.chdir(tempDir);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ...embeddingResponse([[1, 0]]), json: () => Promise.resolve({ embeddings: [[1, 0]] }) })
      .mockRejectedValueOnce(new Error("batch context overflow"))
      .mockResolvedValueOnce({
        ...embeddingResponse([[0.5, 0.5]]),
        json: () => Promise.resolve({ embeddings: [[0.5, 0.5]] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await runBenchmarkForModel("local-model", "owner/repo", [0.85], [benchmarkItem()], {
        provider: "ollama",
      });
      expect(result).toMatchObject({ provider: "ollama", dimensions: 2 });
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const store = new VectorStore(benchmarkDatabasePath("owner/repo", "ollama", "local-model", 2));
      expect(Array.from(store.getAllEmbeddings("owner/repo").values())[0]).toEqual(new Float32Array([0.5, 0.5]));
      store.close();
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("does not carry cloud credentials into an implicit Ollama benchmark", () => {
    const config = resolveBenchmarkProviderConfig(
      {},
      {
        EMBEDDING_API_KEY: "synthetic-cloud-secret",
        EMBEDDING_BASE_URL: "https://compatible.example/v1",
        EMBEDDING_DIMENSIONS: 1024,
      },
    );

    expect(config).toEqual({
      provider: "ollama",
      apiKey: undefined,
      baseUrl: undefined,
      dimensions: undefined,
    });
  });
});
