import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findDuplicateClusters } from "../cluster.js";
import { VectorStore } from "../store.js";
import type { PRItem, StoreItem } from "../types.js";

function tmpDb(): string {
  const dir = resolve(tmpdir(), `prism-cluster-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "test.db");
}

function makePR(n: number, title: string): PRItem {
  return {
    number: n,
    type: "pr",
    repo: "test/repo",
    title,
    body: title,
    state: "open",
    author: "user",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    labels: [],
  };
}

function storeItem(pr: PRItem, embedding: Float32Array): StoreItem {
  return {
    id: `${pr.repo}:${pr.type}:${pr.number}`,
    type: pr.type,
    number: pr.number,
    repo: pr.repo,
    title: pr.title,
    bodySnippet: pr.body.slice(0, 500),
    embedding,
    metadata: { author: pr.author, state: pr.state, labels: pr.labels },
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
  };
}

describe("findDuplicateClusters", () => {
  const dbs: string[] = [];

  afterEach(() => {
    for (const db of dbs) {
      try {
        rmSync(resolve(db, ".."), { recursive: true, force: true });
      } catch {}
    }
    dbs.length = 0;
  });

  it("returns empty when no items", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);
    const clusters = findDuplicateClusters(store, [], { threshold: 0.85, repo: "test/repo" });
    expect(clusters).toEqual([]);
    store.close();
  });

  it("returns empty when all items are unique", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);

    // Orthogonal vectors — similarity = 0
    const items = [makePR(1, "A"), makePR(2, "B")];
    store.upsert(storeItem(items[0], new Float32Array([1, 0, 0, 0])));
    store.upsert(storeItem(items[1], new Float32Array([0, 1, 0, 0])));

    const clusters = findDuplicateClusters(store, items, { threshold: 0.85, repo: "test/repo" });
    expect(clusters).toEqual([]);
    store.close();
  });

  it("clusters identical vectors", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);

    const emb = new Float32Array([1, 2, 3, 4]);
    const items = [makePR(1, "Fix bug"), makePR(2, "Fix bug again"), makePR(3, "Fix bug also")];
    for (const item of items) {
      store.upsert(storeItem(item, emb));
    }

    const clusters = findDuplicateClusters(store, items, { threshold: 0.85, repo: "test/repo" });
    expect(clusters.length).toBe(1);
    expect(clusters[0].items.length).toBe(3);
    expect(clusters[0].avgSimilarity).toBeCloseTo(1.0);
    store.close();
  });

  it("assigns bestPick to highest-scoring item", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);

    const emb = new Float32Array([1, 1, 1, 1]);
    // PR 2 has a longer body = higher descriptionQuality, should be best pick
    const items = [
      { ...makePR(1, "Short"), body: "x" },
      { ...makePR(2, "Long description PR"), body: "a".repeat(600) },
    ];
    for (const item of items) {
      store.upsert(storeItem(item as PRItem, emb));
    }

    const clusters = findDuplicateClusters(store, items as PRItem[], { threshold: 0.85, repo: "test/repo" });
    expect(clusters[0].bestPick.number).toBe(2);
    store.close();
  });

  it("assigns sequential IDs sorted by size", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);

    // Two clusters: one with 3 items, one with 2
    const embA = new Float32Array([1, 0, 0, 0]);
    const embB = new Float32Array([0, 1, 0, 0]);
    const items = [makePR(1, "A1"), makePR(2, "A2"), makePR(3, "A3"), makePR(4, "B1"), makePR(5, "B2")];

    store.upsert(storeItem(items[0], embA));
    store.upsert(storeItem(items[1], embA));
    store.upsert(storeItem(items[2], embA));
    store.upsert(storeItem(items[3], embB));
    store.upsert(storeItem(items[4], embB));

    const clusters = findDuplicateClusters(store, items, { threshold: 0.85, repo: "test/repo" });
    expect(clusters.length).toBe(2);
    expect(clusters[0].id).toBe(1);
    expect(clusters[0].items.length).toBe(3); // larger cluster first
    expect(clusters[1].id).toBe(2);
    expect(clusters[1].items.length).toBe(2);
    store.close();
  });

  it("excludes zero vectors from clustering", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);

    const emb = new Float32Array([1, 1, 1, 1]);
    const zeroEmb = new Float32Array([0, 0, 0, 0]);
    const items = [makePR(1, "Real"), makePR(2, "Real too"), makePR(3, "Failed embed")];

    store.upsert(storeItem(items[0], emb));
    store.upsert(storeItem(items[1], emb));
    store.upsert(storeItem(items[2], zeroEmb));

    const clusters = findDuplicateClusters(store, items, { threshold: 0.85, repo: "test/repo" });
    expect(clusters.length).toBe(1);
    expect(clusters[0].items.length).toBe(2); // zero vector excluded
    store.close();
  });

  it("single item — no cluster formed", () => {
    const path = tmpDb();
    dbs.push(path);
    const store = new VectorStore(path, 4);

    const items = [makePR(1, "Solo")];
    store.upsert(storeItem(items[0], new Float32Array([1, 0, 0, 0])));

    const clusters = findDuplicateClusters(store, items, { threshold: 0.85, repo: "test/repo" });
    expect(clusters).toEqual([]);
    store.close();
  });
});
