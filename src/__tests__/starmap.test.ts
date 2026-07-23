import { describe, expect, it } from "vitest";
import { buildStarmapPayload } from "../starmap.js";
import type { Cluster, ScoredPR } from "../types.js";

function item(number: number, type: "pr" | "issue", score: number, over: Partial<ScoredPR> = {}): ScoredPR {
  return {
    number,
    type,
    repo: "acme/widgets",
    title: `item ${number}`,
    body: "",
    state: "open",
    author: "dev",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    labels: [],
    score,
    signals: {} as ScoredPR["signals"],
    ...over,
  };
}

function cluster(id: number, items: ScoredPR[], avg: number, min: number): Cluster {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  return {
    id,
    items: sorted,
    bestPick: sorted[0],
    avgSimilarity: avg,
    minSimilarity: min,
    theme: sorted[0].title,
  };
}

const META = {
  repo: "acme/widgets",
  threshold: 0.95,
  generatedAt: "2026-07-08T23:02:32.355Z",
  embeddingModel: "nomic-embed-text-v2-moe",
  embeddingProvider: "ollama",
  embeddingDimensions: 768,
  embeddingConfigHash: "ollama:nomic-embed-text-v2-moe:768:t2",
};

describe("buildStarmapPayload", () => {
  it("emits top-level report fields (totalItems = items in clusters)", () => {
    const clusters = [cluster(1, [item(1, "pr", 0.6), item(2, "pr", 0.5)], 0.93, 0.91)];
    const p = buildStarmapPayload(clusters, META);
    expect(p.schemaVersion).toBe(1);
    expect(p.repo).toBe("acme/widgets");
    expect(p.embeddingModel).toBe("nomic-embed-text-v2-moe");
    expect(p.embeddingProvider).toBe("ollama");
    expect(p.embeddingDimensions).toBe(768);
    expect(p.embeddingConfigHash).toBe("ollama:nomic-embed-text-v2-moe:768:t2");
    expect(p.threshold).toBe(0.95);
    expect(p.generatedAt).toBe("2026-07-08T23:02:32.355Z");
    expect(p.totalItems).toBe(2);
    expect(p.clusterCount).toBe(1);
  });

  it("derives the confidence tier from minSimilarity (high/solid/loose)", () => {
    const p = buildStarmapPayload(
      [
        cluster(1, [item(1, "pr", 0.6), item(2, "pr", 0.5)], 0.96, 0.95),
        cluster(2, [item(3, "pr", 0.6), item(4, "pr", 0.5)], 0.9, 0.85),
        cluster(3, [item(5, "pr", 0.6), item(6, "pr", 0.5)], 0.9, 0.75),
      ],
      META,
    );
    expect(p.clusters.map((c) => c.confidence)).toEqual(["high", "solid", "loose"]);
  });

  it("splits members into issues vs PRs and points canonical at the best pick with the right url", () => {
    const c = cluster(7, [item(10, "pr", 0.7), item(11, "issue", 0.5), item(12, "pr", 0.4)], 0.93, 0.9);
    const p = buildStarmapPayload([c], META);
    const out = p.clusters[0];
    expect(out.partition.prs.map((r) => r.number).sort()).toEqual([10, 12]);
    expect(out.partition.issues.map((r) => r.number)).toEqual([11]);
    expect(out.canonical.number).toBe(10);
    expect(out.canonical.url).toBe("https://github.com/acme/widgets/pull/10");
    expect(out.items.find((i) => i.number === 11)!.url).toBe("https://github.com/acme/widgets/issues/11");
  });

  it("carries the GitHub node id through to refs/items when present, omits it when absent", () => {
    const c = cluster(1, [item(1, "pr", 0.6, { nodeId: "PR_kwDO123" }), item(2, "issue", 0.5)], 0.93, 0.9);
    const out = buildStarmapPayload([c], META).clusters[0];
    expect(out.canonical.nodeId).toBe("PR_kwDO123");
    expect(out.items.find((i) => i.number === 1)!.nodeId).toBe("PR_kwDO123");
    expect(out.partition.prs[0].nodeId).toBe("PR_kwDO123");
    // item 2 had no nodeId -> field omitted entirely
    expect("nodeId" in out.items.find((i) => i.number === 2)!).toBe(false);
  });

  it("flags contested clusters when the top two scores are within the tie margin", () => {
    const tight = cluster(1, [item(1, "pr", 0.603), item(2, "pr", 0.6)], 0.93, 0.9); // margin 0.003
    const clear = cluster(2, [item(3, "pr", 0.7), item(4, "pr", 0.5)], 0.93, 0.9); // margin 0.2
    const p = buildStarmapPayload([tight, clear], META);
    expect(p.clusters[0].contested).toBe(true);
    expect(p.clusters[1].contested).toBe(false);
  });

  it("carries item state onto canonical/items/partition and prefers a merged canonical", () => {
    const c = cluster(1, [item(1, "pr", 0.9, { state: "open" }), item(2, "pr", 0.4, { state: "merged" })], 0.93, 0.9);
    const out = buildStarmapPayload([c], META).clusters[0];
    expect(out.canonical.number).toBe(2); // merged PR is the source of truth
    expect(out.canonical.state).toBe("merged");
    expect(out.items.find((i) => i.number === 1)?.state).toBe("open");
    expect(out.partition.prs.find((r) => r.number === 2)?.state).toBe("merged");
  });

  it("omits state from a ref when the source item has no state", () => {
    const c = cluster(1, [item(1, "pr", 0.6, { state: "" }), item(2, "pr", 0.5, { state: "" })], 0.93, 0.9);
    const out = buildStarmapPayload([c], META).clusters[0];
    expect("state" in out.canonical).toBe(false);
  });

  it("emits a tracker: earliest issue as tracker.ref, PRs as fix candidates, later issue as duplicate", () => {
    const c = cluster(
      1,
      [
        item(1, "issue", 0.2, { createdAt: "2026-01-01T00:00:00Z", nodeId: "I_1" }),
        item(2, "pr", 0.9),
        item(3, "issue", 0.8, { createdAt: "2026-02-01T00:00:00Z" }),
      ],
      0.93,
      0.9,
    );
    const out = buildStarmapPayload([c], META).clusters[0];
    expect(out.tracker.needsTracker).toBe(false);
    expect(out.tracker.ref?.number).toBe(1);
    expect(out.tracker.ref?.url).toBe("https://github.com/acme/widgets/issues/1");
    expect(out.tracker.ref?.nodeId).toBe("I_1");
    expect(out.tracker.candidates.map((x) => [x.number, x.role])).toEqual([
      [2, "fix"],
      [3, "duplicate"],
    ]);
    expect(out.tracker.candidates.find((x) => x.number === 2)?.url).toBe("https://github.com/acme/widgets/pull/2");
  });

  it("tracker.needsTracker is true (ref omitted) for a pure-PR cluster; canonical still equals bestPick", () => {
    // PR-majority cluster that contains an issue: canonical (act-on) is the best PR,
    // tracker (original bug) is the issue - they intentionally differ.
    const c = cluster(7, [item(10, "pr", 0.95), item(11, "pr", 0.4), item(12, "issue", 0.1)], 0.93, 0.9);
    const out = buildStarmapPayload([c], META).clusters[0];
    expect(out.canonical.number).toBe(10); // bestPick / source of truth
    expect(out.tracker.ref?.number).toBe(12); // original bug != canonical
    const purePr = cluster(8, [item(20, "pr", 0.9), item(21, "pr", 0.5)], 0.93, 0.9);
    const outPr = buildStarmapPayload([purePr], META).clusters[0];
    expect(outPr.tracker.needsTracker).toBe(true);
    expect(outPr.tracker.ref).toBeUndefined();
    expect(outPr.tracker.candidates.every((x) => x.role === "fix")).toBe(true);
  });

  it("uses canonical-aware contested for issue-majority clusters (time window, not score gap)", () => {
    const base = Date.parse("2026-03-01T00:00:00Z");
    const sixHours = 6 * 60 * 60 * 1000;
    const month = 30 * 24 * 60 * 60 * 1000;
    // two issues 6h apart with far-apart scores: the pick is a near-tie on *time*,
    // even though the score gap is huge (old score-margin logic missed this).
    const tight = cluster(
      1,
      [
        item(10, "issue", 0.1, { createdAt: new Date(base).toISOString() }),
        item(11, "issue", 0.9, { createdAt: new Date(base + sixHours).toISOString() }),
      ],
      0.93,
      0.9,
    );
    // two issues a month apart with near-equal scores: a clear original by time
    // (old score-margin logic wrongly flagged this contested).
    const clear = cluster(
      2,
      [
        item(20, "issue", 0.5, { createdAt: new Date(base).toISOString() }),
        item(21, "issue", 0.48, { createdAt: new Date(base + month).toISOString() }),
      ],
      0.93,
      0.9,
    );
    const p = buildStarmapPayload([tight, clear], META);
    expect(p.clusters[0].canonical.number).toBe(10); // earliest report is canonical
    expect(p.clusters[0].contested).toBe(true);
    expect(p.clusters[0].runnerUp?.number).toBe(11); // second-earliest, not second-highest-score
    expect(p.clusters[1].contested).toBe(false);
    expect(p.clusters[1].runnerUp?.number).toBe(21);
  });

  it("control-strips and length-caps item titles and theme in the payload", () => {
    const ESC = String.fromCharCode(27);
    const c = cluster(
      1,
      [item(1, "pr", 0.9, { title: `evil${ESC}[31m\ntitle` }), item(2, "pr", 0.5, { title: "x".repeat(1000) })],
      0.93,
      0.9,
    );
    const out = buildStarmapPayload([c], META).clusters[0];
    const t1 = out.items.find((i) => i.number === 1)?.title ?? "";
    expect(t1).not.toContain(ESC);
    expect(t1).not.toContain("\n");
    expect(out.items.find((i) => i.number === 2)?.title.length ?? 0).toBeLessThanOrEqual(256);
    expect(out.theme).not.toContain(ESC); // theme derives from the evil title
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  it("places confirmed identity clusters first with confirmed+identity; fuzzy stay fuzzy", () => {
    const fuzzy = cluster(1, [item(1, "pr", 0.6), item(2, "pr", 0.5)], 0.85, 0.82);
    const confirmed: Cluster = {
      id: 0,
      items: [item(11, "pr", 0.4), item(10, "pr", 0.9)],
      bestPick: item(10, "pr", 0.9),
      avgSimilarity: 1,
      minSimilarity: 1,
      theme: "confirmed dup",
      kind: "identity",
      identity: { basis: "head-oid", key: "abc123" },
    };
    const p = buildStarmapPayload([fuzzy], META, { confirmed: [confirmed] });
    expect(p.clusterCount).toBe(2);
    expect(p.totalItems).toBe(4);
    // confirmed sits first
    expect(p.clusters[0].confirmed).toBe(true);
    expect(p.clusters[0].identity).toEqual({ basis: "head-oid", key: "abc123" });
    expect(p.clusters[0].confidence).toBe("high"); // minSim 1
    expect(p.clusters[0].index).toBe(0);
    expect(p.clusters[0].id).toContain("-identity-");
    // fuzzy below, unchanged
    expect(p.clusters[1].confirmed).toBeUndefined();
    expect(p.clusters[1].confidence).toBe("solid"); // minSim 0.82
    expect(p.clusters[1].index).toBe(1);
    expect(p.clusters[1].id).toContain("-cluster-");
  });

  it("without the confirmed opt, no cluster is marked confirmed", () => {
    const c = cluster(3, [item(1, "pr", 0.6), item(2, "pr", 0.5)], 0.9, 0.85);
    const p = buildStarmapPayload([c], META);
    expect(p.clusters[0].confirmed).toBeUndefined();
    expect(p.clusters[0].id).toContain("-cluster-3");
  });
});

describe("buildStarmapPayload relational classification", () => {
  it("emits relation + closingEdges for a linked PR/issue cluster and closes on the PR item", () => {
    const clusters = [cluster(1, [item(10, "pr", 0.6, { closesIssues: [7] }), item(7, "issue", 0.4)], 0.9, 0.88)];
    const c = buildStarmapPayload(clusters, META).clusters[0];
    expect(c.relation).toBe("pr-issue-linked");
    expect(c.closingEdges).toEqual([{ pr: 10, issue: 7 }]);
    expect(c.items.find((i) => i.number === 10)?.closes).toEqual([7]);
    expect(c.items.find((i) => i.number === 7)?.closes).toBeUndefined();
  });

  it("keeps relation with empty closingEdges for a known-unlinked mixed cluster", () => {
    const clusters = [cluster(1, [item(10, "pr", 0.6, { closesIssues: [] }), item(7, "issue", 0.4)], 0.9, 0.88)];
    const c = buildStarmapPayload(clusters, META).clusters[0];
    expect(c.relation).toBe("pr-issue-unlinked");
    expect(c.closingEdges).toEqual([]);
  });

  it("omits relation, closingEdges, and closes entirely when a member PR predates the field", () => {
    const clusters = [cluster(1, [item(10, "pr", 0.6), item(7, "issue", 0.4)], 0.9, 0.88)];
    const c = buildStarmapPayload(clusters, META).clusters[0];
    const json = JSON.stringify(c);
    expect(json).not.toContain("relation");
    expect(json).not.toContain("closingEdges");
    expect(json).not.toContain('"closes"');
  });

  it("labels composition-only clusters without needing closesIssues and keeps schemaVersion 1", () => {
    const clusters = [cluster(1, [item(1, "pr", 0.6), item(2, "pr", 0.5)], 0.93, 0.91)];
    const p = buildStarmapPayload(clusters, META);
    expect(p.clusters[0].relation).toBe("prs-only");
    expect(p.clusters[0].closingEdges).toEqual([]);
    expect(p.schemaVersion).toBe(1);
  });
});

describe("confirmed clusters in the starmap payload", () => {
  it("canonical follows earliest-created for identity clusters and items carry createdAt", () => {
    const original = item(100, "pr", 0.2, { createdAt: "2026-01-01T00:00:00Z" });
    const copy = item(200, "pr", 0.9, { createdAt: "2026-03-01T00:00:00Z" });
    const confirmed: Cluster = {
      ...cluster(1, [original, copy], 1, 1),
      kind: "identity",
      identity: { basis: "head-oid", key: "oid" },
    };
    const p = buildStarmapPayload([], META, { confirmed: [confirmed] });
    expect(p.clusters[0].canonical.number).toBe(100);
    expect(p.clusters[0].items.every((i) => i.createdAt !== undefined)).toBe(true);
  });

  it("fuzzy PR clusters keep the quality-score canonical rule", () => {
    const clusters = [
      cluster(
        1,
        [
          item(10, "pr", 0.9, { createdAt: "2026-03-01T00:00:00Z" }),
          item(11, "pr", 0.2, { createdAt: "2026-01-01T00:00:00Z" }),
        ],
        0.9,
        0.88,
      ),
    ];
    expect(buildStarmapPayload(clusters, META).clusters[0].canonical.number).toBe(10);
  });
});
