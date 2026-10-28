import { describe, expect, it } from "vitest";
import fixtureItems from "../maintainer/__fixtures__/items.json";
import {
  generateBacklogJson,
  generateBacklogReport,
  generateDuplicatesReport,
  generatePriorityReport,
  generateProgressReport,
} from "../maintainer/reports.js";
import type { MaintainerItem } from "../maintainer/types.js";

const items = fixtureItems as MaintainerItem[];

describe("generateBacklogReport", () => {
  it("is deterministic (same input → same output)", () => {
    const r1 = generateBacklogReport(items, "odysseus-dev/odysseus");
    const r2 = generateBacklogReport(items, "odysseus-dev/odysseus");
    expect(r1).toBe(r2);
  });

  it("advisory data is labeled", () => {
    const report = generateBacklogReport(items, "odysseus-dev/odysseus");
    expect(report).toContain("advisory");
    expect(report).toContain("source");
  });

  it("safe to rerun (no side effects)", () => {
    const itemsCopy = JSON.parse(JSON.stringify(items));
    generateBacklogReport(items, "odysseus-dev/odysseus");
    expect(items).toEqual(itemsCopy);
  });

  it("never presents model recommendations as confirmed facts", () => {
    const report = generateBacklogReport(items, "odysseus-dev/odysseus");
    expect(report).toContain("Model recommendations are advisory signals and not independently verified facts");
  });
});

describe("generatePriorityReport", () => {
  it("generates markdown report with advisory labels and PR details", () => {
    const report = generatePriorityReport(items, "odysseus-dev/odysseus");
    expect(report).toContain("# Maintainer Priority PR Queue: odysseus-dev/odysseus");
    expect(report).toContain("[advisory]");
    expect(report).toContain("[source]");
    expect(report).toContain("PR #101");
  });

  it("is deterministic for identical input", () => {
    const r1 = generatePriorityReport(items, "odysseus-dev/odysseus");
    const r2 = generatePriorityReport(items, "odysseus-dev/odysseus");
    expect(r1).toBe(r2);
  });
});

describe("generateDuplicatesReport", () => {
  it("clearly distinguishes confirmed identity duplicates from fuzzy candidates", () => {
    const report = generateDuplicatesReport(items, "odysseus-dev/odysseus");
    expect(report).toContain("Confirmed Duplicates (Identity Matches)");
    expect(report).toContain("Fuzzy Duplicate Candidates (Semantic Similarity)");
    expect(report).toContain("embedding similarity is NOT a confirmed duplicate");
  });

  it("is deterministic for identical input", () => {
    const r1 = generateDuplicatesReport(items, "odysseus-dev/odysseus");
    const r2 = generateDuplicatesReport(items, "odysseus-dev/odysseus");
    expect(r1).toBe(r2);
  });
});

describe("generateProgressReport", () => {
  it("computes progress metrics by priority tier and evidence freshness", () => {
    const report = generateProgressReport(items, "odysseus-dev/odysseus");
    expect(report).toContain("# Review Progress Report: odysseus-dev/odysseus");
    expect(report).toContain("Progress by Priority Tier");
    expect(report).toContain("Evidence Freshness");
    expect(report).toContain("Fresh Evidence [source]:");
    expect(report).toContain("Stale Evidence [source]:");
  });
});

describe("generateBacklogJson", () => {
  it("returns structured counts matching fixture expectations", () => {
    const json = generateBacklogJson(items, "odysseus-dev/odysseus");
    expect(json.repo).toBe("odysseus-dev/odysseus");
    expect(json.summary.totalOpen).toBe(9);
    expect(json.summary.totalClosed).toBe(1);
    expect(json.summary.prs).toBe(8);
    expect(json.summary.issues).toBe(2);
    expect(json.summary.confirmedDuplicates).toBe(1);
    expect(json.prioritizedPrs.length).toBe(8);
    expect(json.prioritizedIssues.length).toBe(2);
  });
});
