import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VectorStore } from "../store.js";

function tmpDb(): string {
  const dir = resolve(tmpdir(), `prism-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "test.db");
}

describe("VectorStore", () => {
  const dbs: string[] = [];

  afterEach(() => {
    for (const db of dbs) {
      try {
        rmSync(resolve(db, ".."), { recursive: true, force: true });
      } catch {}
    }
    dbs.length = 0;
  });

  it("getMeta/setMeta round-trip", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 384);
    store.setMeta("test_key", "test_value");
    expect(store.getMeta("test_key")).toBe("test_value");
    store.setMeta("test_key", "updated");
    expect(store.getMeta("test_key")).toBe("updated");
    expect(store.getMeta("nonexistent")).toBeUndefined();
    store.close();
  });

  it("throws on embedding model mismatch", () => {
    const path = tmpDb();
    dbs.push(path);
    const store1 = new VectorStore(path, 384, "model-a");
    store1.setMeta("embedding_model", "model-a");
    store1.close();

    expect(() => new VectorStore(path, 384, "model-b")).toThrow("embedding model changed");
  });

  it("no mismatch when model matches", () => {
    const path = tmpDb();
    dbs.push(path);
    const store1 = new VectorStore(path, 384, "model-a");
    store1.setMeta("embedding_model", "model-a");
    store1.close();

    const store2 = new VectorStore(path, 384, "model-a");
    expect(store2.getMeta("embedding_model")).toBe("model-a");
    store2.close();
  });

  it("skips model check when no model specified", () => {
    const path = tmpDb();
    dbs.push(path);
    const store1 = new VectorStore(path, 384, "model-a");
    store1.setMeta("embedding_model", "model-a");
    store1.close();

    // No model param = skip check (used by status command)
    const store2 = new VectorStore(path, 384);
    expect(store2.getMeta("embedding_model")).toBe("model-a");
    store2.close();
  });

  it("dropVecItems and initVecItems", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 384);
    store.dropVecItems();
    store.initVecItems();
    // Should not throw
    const results = store.search(new Float32Array(384), 5);
    expect(results).toEqual([]);
    store.close();
  });

  it("upsertEmbeddingOnly", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 384);
    const emb = new Float32Array(384).fill(0.1);
    store.upsertEmbeddingOnly("test:pr:1", emb);
    const retrieved = store.getEmbedding("test:pr:1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.length).toBe(384);
    store.close();
  });

  it("detects whether the database contains any embeddings", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);
    expect(store.hasEmbeddings()).toBe(false);
    store.upsertEmbeddingOnly("other/repo:pr:1", new Float32Array([1, 0, 0, 0]));
    expect(store.hasEmbeddings()).toBe(true);
    store.close();
  });

  it("dimension mismatch throws", () => {
    const path = tmpDb();
    dbs.push(path);
    const store1 = new VectorStore(path, 384);
    store1.upsertEmbeddingOnly("test:pr:1", new Float32Array(384).fill(0.1));
    store1.close();

    expect(() => new VectorStore(path, 1024)).toThrow("dimension mismatch");
  });

  it("read-only mode (undefined dimensions) detects existing dims", () => {
    const path = tmpDb();
    dbs.push(path);
    const store1 = new VectorStore(path, 384);
    store1.upsertEmbeddingOnly("test:pr:1", new Float32Array(384).fill(0.1));
    store1.close();

    // undefined dimensions = read-only, should auto-detect 384
    const store2 = new VectorStore(path, undefined);
    const emb = store2.getEmbedding("test:pr:1");
    expect(emb).toBeDefined();
    expect(emb!.length).toBe(384);
    store2.close();
  });

  it("getAllEmbeddings returns all embeddings for repo", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);
    store.upsert({
      id: "test/repo:pr:1",
      type: "pr",
      number: 1,
      repo: "test/repo",
      title: "T",
      bodySnippet: "B",
      embedding: new Float32Array([1, 2, 3, 4]),
      metadata: {},
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    });
    store.upsert({
      id: "test/repo:pr:2",
      type: "pr",
      number: 2,
      repo: "test/repo",
      title: "T2",
      bodySnippet: "B2",
      embedding: new Float32Array([5, 6, 7, 8]),
      metadata: {},
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    });

    const embeddings = store.getAllEmbeddings("test/repo");
    expect(embeddings.size).toBe(2);
    expect(embeddings.get("test/repo:pr:1")!.length).toBe(4);
    store.close();
  });

  it("getStats returns correct counts", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);
    store.upsert({
      id: "r:pr:1",
      type: "pr",
      number: 1,
      repo: "r",
      title: "T",
      bodySnippet: "B",
      embedding: new Float32Array([1, 0, 0, 0]),
      metadata: {},
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    });
    store.upsert({
      id: "r:issue:1",
      type: "issue",
      number: 1,
      repo: "r",
      title: "T",
      bodySnippet: "B",
      embedding: new Float32Array([0, 1, 0, 0]),
      metadata: {},
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    });

    const stats = store.getStats("r");
    expect(stats.prs).toBe(1);
    expect(stats.issues).toBe(1);
    expect(stats.totalItems).toBe(2);
    store.close();
  });

  it("empty store returns empty stats", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);
    const stats = store.getStats("nonexistent");
    expect(stats.totalItems).toBe(0);
    expect(stats.prs).toBe(0);
    store.close();
  });

  it("hydrates headRefOid from metadata in getAllItems and the multi-repo path", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);
    const mk = (repo: string, n: number, oid: string) => ({
      id: `${repo}:pr:${n}`,
      type: "pr" as const,
      number: n,
      repo,
      title: "T",
      bodySnippet: "B",
      embedding: new Float32Array([1, 2, 3, 4]),
      metadata: { headRefOid: oid },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    store.upsert(mk("o/a", 1, "oidA"));
    store.upsert(mk("o/b", 2, "oidB"));

    const single = store.getAllItems("o/a") as unknown as Array<{ headRefOid?: string }>;
    expect(single[0].headRefOid).toBe("oidA");

    const multi = store.getAllItemsMulti(["o/a", "o/b"]) as unknown as Array<{
      number: number;
      headRefOid?: string;
    }>;
    expect(multi.find((i) => i.number === 1)?.headRefOid).toBe("oidA");
    expect(multi.find((i) => i.number === 2)?.headRefOid).toBe("oidB");
    store.close();
  });
});

describe("closesIssues metadata round-trip", () => {
  const dbs: string[] = [];

  afterEach(() => {
    for (const db of dbs) {
      try {
        rmSync(resolve(db, ".."), { recursive: true, force: true });
      } catch {}
    }
    dbs.length = 0;
  });

  function seeded(path: string, closesIssues?: number[]) {
    const store = new VectorStore(path, 2, "test-model");
    store.upsert({
      id: "owner/repo:pr:10",
      type: "pr",
      number: 10,
      repo: "owner/repo",
      title: "a pr",
      bodySnippet: "body",
      embedding: new Float32Array([1, 0]),
      metadata: { author: "dev", state: "open", labels: [], ...(closesIssues !== undefined ? { closesIssues } : {}) },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    return store;
  }

  it("surfaces closesIssues on getAllItems and getAllItemsMulti", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = seeded(path, [7, 8]);
    expect((store.getAllItems("owner/repo")[0] as any).closesIssues).toEqual([7, 8]);
    expect((store.getAllItemsMulti(["owner/repo", "owner/other"])[0] as any).closesIssues).toEqual([7, 8]);
    store.close();
  });

  it("leaves closesIssues undefined for pre-upgrade rows", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = seeded(path);
    expect((store.getAllItems("owner/repo")[0] as any).closesIssues).toBeUndefined();
    store.close();
  });

  it("refreshMetadata updates metadata without touching the embedding", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = seeded(path);
    store.refreshMetadata("owner/repo:pr:10", {
      author: "dev",
      state: "open",
      labels: [],
      ciStatus: "failure",
      closesIssues: [7],
    });
    const item = store.getAllItems("owner/repo")[0] as any;
    expect(item.closesIssues).toEqual([7]);
    expect(item.ciStatus).toBe("failure");
    expect(store.getEmbedding("owner/repo:pr:10")).toEqual(new Float32Array([1, 0]));
    store.close();
  });

  it("refreshMetadata on a missing id is a no-op", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = seeded(path);
    store.refreshMetadata("owner/repo:pr:999", { closesIssues: [1] });
    expect(store.getAllItems("owner/repo")).toHaveLength(1);
    store.close();
  });
});
