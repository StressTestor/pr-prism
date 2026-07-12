import { describe, expect, it } from "vitest";
import { buildHousekeepingManifest } from "../housekeeping.js";
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

function cluster(items: ScoredPR[], min: number, over: Partial<Cluster> = {}): Cluster {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  return {
    id: 1,
    items: sorted,
    bestPick: sorted[0],
    avgSimilarity: min,
    minSimilarity: min,
    theme: sorted[0].title,
    ...over,
  };
}

describe("buildHousekeepingManifest", () => {
  it("header shows the repo and confirmed/loose counts, and states it never writes", () => {
    const c = cluster([item(1, "issue", 0.2, { createdAt: "2026-01-01T00:00:00Z" }), item(2, "pr", 0.9)], 0.86);
    const md = buildHousekeepingManifest([c], { repo: "acme/widgets" });
    expect(md).toContain("# pr-prism housekeeping");
    expect(md).toContain("acme/widgets");
    expect(md).toMatch(/never writes/i);
  });

  it("an issue-anchored cluster names the tracker and gives paste-ready close lines", () => {
    const c = cluster(
      [
        item(10, "issue", 0.2, { createdAt: "2026-01-01T00:00:00Z", title: "login crashes" }),
        item(11, "pr", 0.9, { title: "fix login" }),
      ],
      0.86,
    );
    const md = buildHousekeepingManifest([c], { repo: "acme/widgets" });
    expect(md).toMatch(/tracker.*#10/i);
    expect(md).toContain("duplicate of #10");
    expect(md).toContain("- [ ]"); // editable checkbox for the fix candidate #11
    expect(md).toContain("#11");
  });

  it("a loose cluster is flagged for review and does NOT give a blanket close directive", () => {
    const c = cluster(
      [item(20, "issue", 0.1, { createdAt: "2026-01-01T00:00:00Z" }), item(21, "pr", 0.9)],
      0.6, // loose
    );
    const md = buildHousekeepingManifest([c], { repo: "acme/widgets" });
    expect(md).toMatch(/loose|review/i);
    expect(md).toMatch(/verify/i);
    expect(md).not.toContain("close as `duplicate of #20`");
  });

  it("a pure-PR cluster says no tracker issue is filed", () => {
    const c = cluster([item(30, "pr", 0.9), item(31, "pr", 0.5)], 0.86);
    const md = buildHousekeepingManifest([c], { repo: "acme/widgets" });
    expect(md).toMatch(/no tracker issue/i);
  });

  it("confirmed identity clusters (passed via opts.confirmed) are marked confirmed and come first", () => {
    const fuzzy = cluster([item(1, "issue", 0.2, { createdAt: "2026-01-01T00:00:00Z" }), item(2, "pr", 0.9)], 0.86);
    const confirmed = cluster([item(50, "pr", 0.9), item(51, "pr", 0.4)], 1, {
      kind: "identity",
      identity: { basis: "head-oid", key: "abc" },
    });
    const md = buildHousekeepingManifest([fuzzy], { repo: "acme/widgets", confirmed: [confirmed] });
    expect(md).toMatch(/confirmed/i);
    // the confirmed section appears before the fuzzy tracker section
    expect(md.indexOf("#50")).toBeLessThan(md.indexOf("#2"));
    // confirmed PR-pair: keep the canonical (#50), close the rest against it -
    // NOT the "no tracker issue, open one" text
    expect(md).toContain("duplicate of #50");
    expect(md).toContain("#51");
    const confirmedSection = md.slice(md.indexOf("confirmed duplicate"), md.indexOf("#2"));
    expect(confirmedSection).not.toMatch(/no tracker issue/i);
  });

  it("builds each item link from its own repo, not the manifest-level repo (cross-repo)", () => {
    const c = cluster(
      [
        item(1, "issue", 0.2, { repo: "org/frontend", createdAt: "2026-01-01T00:00:00Z" }),
        item(2, "pr", 0.9, { repo: "org/backend" }),
      ],
      0.86,
    );
    const md = buildHousekeepingManifest([c], { repo: "org/frontend, org/backend" });
    expect(md).toContain("https://github.com/org/frontend/issues/1");
    expect(md).toContain("https://github.com/org/backend/pull/2");
    expect(md).not.toContain("https://github.com/org/frontend, org/backend/");
  });

  it("sanitizes control chars out of titles", () => {
    const c = cluster(
      [
        item(60, "issue", 0.2, { createdAt: "2026-01-01T00:00:00Z", title: `evil${String.fromCharCode(10)}title` }),
        item(61, "pr", 0.9),
      ],
      0.86,
    );
    const md = buildHousekeepingManifest([c], { repo: "acme/widgets" });
    expect(md).not.toContain("evil\ntitle");
    expect(md).toContain("evil title");
  });
});
