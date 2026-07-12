import { describe, expect, it } from "vitest";
import { diffFingerprint, findConfirmedDuplicates } from "../identity.js";
import type { PRItem } from "../types.js";

function pr(number: number, over: Partial<PRItem> = {}): PRItem {
  return {
    number,
    type: "pr",
    repo: "o/r",
    title: `pr ${number}`,
    body: "",
    state: "open",
    author: "dev",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    labels: [],
    ...over,
  };
}

describe("findConfirmedDuplicates", () => {
  it("groups two PRs sharing a head commit OID into one identity cluster", () => {
    const groups = findConfirmedDuplicates([
      pr(1, { headRefOid: "abc123" }),
      pr(2, { headRefOid: "abc123" }),
      pr(3, { headRefOid: "def456" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("identity");
    expect(groups[0].identity).toEqual({ basis: "head-oid", key: "abc123" });
    expect(groups[0].items.map((i) => i.number).sort()).toEqual([1, 2]);
    expect(groups[0].avgSimilarity).toBe(1);
    expect(groups[0].minSimilarity).toBe(1);
    expect([1, 2]).toContain(groups[0].bestPick.number);
  });

  it("ignores PRs with undefined/empty headRefOid and ignores issues entirely", () => {
    const groups = findConfirmedDuplicates([
      pr(1, { headRefOid: undefined }),
      pr(2, { headRefOid: "" }),
      { ...pr(3), type: "issue", headRefOid: "shared" } as PRItem,
      { ...pr(4), type: "issue", headRefOid: "shared" } as PRItem,
    ]);
    expect(groups).toHaveLength(0);
  });

  it("groups PRs with identical cached diffs under patch-id when head-oids differ", () => {
    const same = "diff --git a/x b/x\nindex 111..222\n@@ -1 +1 @@\n-a\n+b\n";
    const store = {
      getCachedDiff: (_repo: string, n: number) => (n <= 2 ? same : "diff --git a/y b/y\n+other\n"),
    } as unknown as import("../store.js").VectorStore;
    const groups = findConfirmedDuplicates(
      [pr(1, { headRefOid: "oid1" }), pr(2, { headRefOid: "oid2" }), pr(3, { headRefOid: "oid3" })],
      { store },
    );
    const patch = groups.filter((g) => g.identity?.basis === "patch-id");
    expect(patch).toHaveLength(1);
    expect(patch[0].items.map((i) => i.number).sort()).toEqual([1, 2]);
  });

  it("does not create a confirmed group from content-free diffs (only index/hunk lines)", () => {
    const store = {
      getCachedDiff: () => "index 111..222\n@@ -1 +1 @@\n",
    } as unknown as import("../store.js").VectorStore;
    const groups = findConfirmedDuplicates([pr(1, { headRefOid: "a" }), pr(2, { headRefOid: "b" })], { store });
    expect(groups.filter((g) => g.identity?.basis === "patch-id")).toHaveLength(0);
  });

  it("head-oid takes precedence over patch-id (a claimed PR is not re-grouped)", () => {
    const store = {
      getCachedDiff: () => "diff\n+same\n",
    } as unknown as import("../store.js").VectorStore;
    const groups = findConfirmedDuplicates(
      [pr(1, { headRefOid: "shared" }), pr(2, { headRefOid: "shared" }), pr(3, { headRefOid: "other" })],
      { store },
    );
    expect(groups.filter((g) => g.identity?.basis === "head-oid")).toHaveLength(1);
    expect(groups.filter((g) => g.identity?.basis === "patch-id")).toHaveLength(0);
  });
});

describe("diffFingerprint", () => {
  it("ignores index and hunk-range lines but not content", () => {
    const a = "diff --git a/x b/x\nindex 111..222 100644\n@@ -1,2 +1,2 @@\n-a\n+b\n";
    const b = "diff --git a/x b/x\nindex 999..888 100644\n@@ -5,9 +5,9 @@\n-a\n+b\n";
    const c = "diff --git a/x b/x\nindex 111..222 100644\n@@ -1,2 +1,2 @@\n-a\n+DIFFERENT\n";
    expect(diffFingerprint(a)).toBe(diffFingerprint(b));
    expect(diffFingerprint(a)).not.toBe(diffFingerprint(c));
  });
});
