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
};

describe("buildStarmapPayload", () => {
  it("emits top-level report fields (totalItems = items in clusters)", () => {
    const clusters = [cluster(1, [item(1, "pr", 0.6), item(2, "pr", 0.5)], 0.93, 0.91)];
    const p = buildStarmapPayload(clusters, META);
    expect(p.schemaVersion).toBe(1);
    expect(p.repo).toBe("acme/widgets");
    expect(p.embeddingModel).toBe("nomic-embed-text-v2-moe");
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
});
