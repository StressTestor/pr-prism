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
});
