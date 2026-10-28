import { describe, expect, it } from "vitest";
import { discoverRelationshipCandidates, RELATIONSHIP_SCHEMA_VERSION } from "../housekeeping/relationship-discovery.js";
import type { Cluster, PRItem, ScoredPR } from "../types.js";

function createMockItem(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 1,
    type: "pr",
    repo: "owner/repo",
    title: "Mock PR",
    body: "Mock description",
    state: "open",
    author: "contributor",
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
    labels: [],
    ...overrides,
  };
}

function createMockCluster(items: PRItem[], overrides: Partial<Cluster> = {}): Cluster {
  const scoredItems: ScoredPR[] = items.map((item) => ({
    ...item,
    score: 0.8,
    signals: {
      hasTests: 1,
      ciPassing: 1,
      diffSize: 0.5,
      authorHistory: 0.5,
      descriptionQuality: 0.7,
      reviewApprovals: 0.5,
    },
  }));

  return {
    id: 1,
    items: scoredItems,
    bestPick: scoredItems[0],
    avgSimilarity: 0.88,
    minSimilarity: 0.85,
    theme: items[0]?.title ?? "Cluster theme",
    kind: "fuzzy",
    ...overrides,
  };
}

describe("Task A — Candidate Relationship Discovery Engine", () => {
  // ── TEST 1: Head-OID identity detection ───────────────────────────────────
  it("detects identity duplicates via headRefOid match as IDENTITY_DUPLICATE, DETERMINISTIC", () => {
    const pr1 = createMockItem({ number: 101, headRefOid: "commit_abc123" });
    const pr2 = createMockItem({ number: 102, headRefOid: "commit_abc123" });
    const result = discoverRelationshipCandidates([pr1, pr2], []);

    expect(result.schemaVersion).toBe(RELATIONSHIP_SCHEMA_VERSION);
    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.kind).toBe("IDENTITY_DUPLICATE");
    expect(candidate.evidenceTier).toBe("DETERMINISTIC");
    expect(candidate.evidenceFactors).toContain("head_oid_match");
    expect(candidate.sourceNumber).toBe(101);
    expect(candidate.targetNumber).toBe(102);
    expect(candidate.requiresJevValidation).toBe(false);
    expect(candidate.requiresHumanVerification).toBe(true);
    expect(candidate.schemaVersion).toBe(RELATIONSHIP_SCHEMA_VERSION);
    expect(result.indexedByHeadOid).toBe(2);
  });

  // ── TEST 2: Closing reference ─────────────────────────────────────────────
  it("detects closing reference from PR closesIssues to in-scope issue as CLOSES_REFERENCE, STRONG", () => {
    const pr = createMockItem({
      number: 10,
      type: "pr",
      state: "open",
      closesIssues: [7],
    });
    const issue = createMockItem({
      number: 7,
      type: "issue",
      state: "open",
    });
    const result = discoverRelationshipCandidates([pr, issue], []);

    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.kind).toBe("CLOSES_REFERENCE");
    expect(candidate.evidenceTier).toBe("STRONG");
    expect(candidate.sourceNumber).toBe(10);
    expect(candidate.targetNumber).toBe(7);
    expect(candidate.closingEdge).toBe(true);
    expect(candidate.evidenceFactors).toContain("closes_reference");
    expect(candidate.requiresJevValidation).toBe(false);
    expect(candidate.requiresHumanVerification).toBe(true);
    expect(result.indexedByClosingRef).toBe(1);
  });

  // ── TEST 3: Cross-reference body scan ─────────────────────────────────────
  it("scans body text for #NNN references to in-scope items as CROSS_REFERENCE", () => {
    const pr = createMockItem({
      number: 5,
      type: "pr",
      body: "This fixes edge cases related to #15 and enhances stability.",
    });
    const issue15 = createMockItem({
      number: 15,
      type: "issue",
    });
    const result = discoverRelationshipCandidates([pr, issue15], []);

    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.kind).toBe("CROSS_REFERENCE");
    expect(candidate.evidenceTier).toBe("MODERATE");
    expect(candidate.sourceNumber).toBe(5);
    expect(candidate.targetNumber).toBe(15);
    expect(candidate.evidenceFactors).toContain("cross_reference");
    expect(candidate.requiresJevValidation).toBe(true);
    expect(candidate.requiresHumanVerification).toBe(true);
    expect(result.indexedByCrossRef).toBe(1);
  });

  // ── TEST 4: Cluster-based duplicate ───────────────────────────────────────
  it("emits DUPLICATE_CANDIDATE with MODERATE/STRONG evidence for two issues in same cluster, sim=0.88", () => {
    const issue1 = createMockItem({ number: 21, type: "issue", title: "Memory leak in parser" });
    const issue2 = createMockItem({ number: 22, type: "issue", title: "Parser consumes unbounded RAM" });
    const cluster = createMockCluster([issue1, issue2], { avgSimilarity: 0.88, minSimilarity: 0.88 });

    const result = discoverRelationshipCandidates([issue1, issue2], [cluster]);

    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.kind).toBe("DUPLICATE_CANDIDATE");
    expect(["MODERATE", "STRONG"]).toContain(candidate.evidenceTier);
    expect(candidate.embeddingSimilarity).toBe(0.88);
    expect(candidate.evidenceFactors).toContain("embedding_sim:0.88");
    expect(candidate.requiresHumanVerification).toBe(true);
    expect(result.indexedByEmbedding).toBe(2);
  });

  // ── TEST 5: Supersession ──────────────────────────────────────────────────
  it("detects SUPERSEDED_CANDIDATE when a newer open PR addresses same area as older PR in cluster", () => {
    const olderPR = createMockItem({
      number: 31,
      type: "pr",
      createdAt: "2026-01-01T00:00:00Z",
      state: "open",
      title: "Old refactor of transport",
    });
    const newerPR = createMockItem({
      number: 45,
      type: "pr",
      createdAt: "2026-02-15T00:00:00Z",
      state: "open",
      title: "Modern transport rewrite",
    });
    const cluster = createMockCluster([olderPR, newerPR], { avgSimilarity: 0.86 });

    const result = discoverRelationshipCandidates([olderPR, newerPR], [cluster]);

    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.kind).toBe("SUPERSEDED_CANDIDATE");
    expect(candidate.sourceNumber).toBe(45); // newer open PR
    expect(candidate.targetNumber).toBe(31); // older PR
    expect(candidate.requiresJevValidation).toBe(true);
    expect(candidate.requiresHumanVerification).toBe(true);
    expect(candidate.evidenceFactors).toContain("newer_open_pr");
  });

  // ── TEST 6: No all-pairs quadratic comparisons ────────────────────────────
  it("does NOT perform all-pairs comparisons; emits 0 candidates when no clusters or signals exist", () => {
    const items: PRItem[] = [];
    for (let i = 1; i <= 50; i++) {
      items.push(
        createMockItem({
          number: i,
          type: i % 2 === 0 ? "pr" : "issue",
          body: `Standard item ${i} with no cross references`,
          headRefOid: undefined,
          closesIssues: undefined,
        }),
      );
    }

    const result = discoverRelationshipCandidates(items, []);
    expect(result.candidateCount).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.indexedByEmbedding).toBe(0);
    expect(result.indexedByClosingRef).toBe(0);
    expect(result.indexedByHeadOid).toBe(0);
    expect(result.indexedByCrossRef).toBe(0);
  });

  // ── TEST 7: Old issue NOT marked obsolete just because it's old ───────────
  it("does NOT mark an old issue obsolete merely due to age", () => {
    const ancientIssue = createMockItem({
      number: 3,
      type: "issue",
      createdAt: "2018-01-01T00:00:00Z",
      updatedAt: "2018-06-01T00:00:00Z",
      body: "Long-standing architectural concern",
      state: "open",
    });
    const result = discoverRelationshipCandidates([ancientIssue], []);

    expect(result.candidateCount).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  // ── TEST 8: Deduplication: same pair discovered via two paths ─────────────
  it("deduplicates candidates when the same pair is discovered via multiple paths into only one candidate", () => {
    // Both PRs cross-reference each other
    const pr1 = createMockItem({
      number: 10,
      type: "pr",
      body: "See discussion on #20",
    });
    const pr2 = createMockItem({
      number: 20,
      type: "pr",
      body: "Coordinating with #10",
    });

    const result = discoverRelationshipCandidates([pr1, pr2], []);
    expect(result.candidateCount).toBe(1);
    const c = result.candidates[0];
    expect(c.kind).toBe("CROSS_REFERENCE");
    expect([c.sourceNumber, c.targetNumber].sort()).toEqual([10, 20]);
  });

  // ── TEST 9: requiresHumanVerification is ALWAYS true ──────────────────────
  it("enforces requiresHumanVerification: true on every generated candidate", () => {
    const pr1 = createMockItem({ number: 1, headRefOid: "oid123" });
    const pr2 = createMockItem({ number: 2, headRefOid: "oid123" });
    const pr3 = createMockItem({ number: 3, closesIssues: [4] });
    const issue4 = createMockItem({ number: 4, type: "issue" });
    const issue5 = createMockItem({ number: 5, type: "issue", body: "Check #6" });
    const issue6 = createMockItem({ number: 6, type: "issue" });

    const cluster = createMockCluster([issue5, issue6], { avgSimilarity: 0.9 });

    const result = discoverRelationshipCandidates([pr1, pr2, pr3, issue4, issue5, issue6], [cluster]);

    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
    for (const candidate of result.candidates) {
      expect(candidate.requiresHumanVerification).toBe(true);
    }
  });

  // ── TEST 10: Labels-only overlap does NOT create candidate on its own ─────
  it("does NOT emit candidate for items sharing labels alone without other relationship signals", () => {
    const item1 = createMockItem({
      number: 50,
      type: "issue",
      labels: ["bug", "frontend", "performance"],
      body: "Unrelated task A",
    });
    const item2 = createMockItem({
      number: 51,
      type: "issue",
      labels: ["bug", "frontend", "performance"],
      body: "Unrelated task B",
    });

    const result = discoverRelationshipCandidates([item1, item2], []);
    expect(result.candidateCount).toBe(0);
  });

  // ── TEST 11: Cross-repo closing edges are NOT emitted ─────────────────────
  it("does NOT emit cross-repo closing edges between different repositories", () => {
    const prInRepoA = createMockItem({
      number: 100,
      type: "pr",
      repo: "owner/repo-a",
      closesIssues: [200],
    });
    const issueInRepoB = createMockItem({
      number: 200,
      type: "issue",
      repo: "owner/repo-b",
    });

    const result = discoverRelationshipCandidates([prInRepoA, issueInRepoB], []);
    expect(result.candidateCount).toBe(0);
  });

  // ── BONUS 12: ALREADY_FIXED_CANDIDATE for merged PR + open issue ──────────
  it("emits ALREADY_FIXED_CANDIDATE when PR is merged and target issue is open", () => {
    const mergedPR = createMockItem({
      number: 88,
      type: "pr",
      state: "merged",
      closesIssues: [42],
    });
    const openIssue = createMockItem({
      number: 42,
      type: "issue",
      state: "open",
    });

    const result = discoverRelationshipCandidates([mergedPR, openIssue], []);
    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.kind).toBe("ALREADY_FIXED_CANDIDATE");
    expect(candidate.evidenceTier).toBe("STRONG");
    expect(candidate.evidenceFactors).toContain("merged_pr");
    expect(candidate.evidenceFactors).toContain("closes_reference");
    expect(candidate.requiresJevValidation).toBe(false);
    expect(candidate.requiresHumanVerification).toBe(true);
  });

  // ── BONUS 13: Mixed cluster emits SAME_UNDERLYING_PROBLEM ─────────────────
  it("emits SAME_UNDERLYING_PROBLEM for PR and issue in the same cluster without direct closing edge", () => {
    const pr = createMockItem({
      number: 60,
      type: "pr",
      state: "open",
      closesIssues: [], // does not close issue 61
      title: "Alternative fix for crash",
    });
    const issue = createMockItem({
      number: 61,
      type: "issue",
      state: "open",
      title: "App crash on startup",
    });

    const cluster = createMockCluster([pr, issue], { avgSimilarity: 0.89 });
    const result = discoverRelationshipCandidates([pr, issue], [cluster]);

    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.kind).toBe("SAME_UNDERLYING_PROBLEM");
    expect(candidate.requiresHumanVerification).toBe(true);
  });

  // ── BONUS 14: Label overlap combined with cluster promotes to STRONG ──────
  it("includes label overlap in evidence factors and elevates evidence tier", () => {
    const issue1 = createMockItem({
      number: 70,
      type: "issue",
      labels: ["bug", "auth", "security"],
    });
    const issue2 = createMockItem({
      number: 71,
      type: "issue",
      labels: ["bug", "auth", "security"],
    });

    const cluster = createMockCluster([issue1, issue2], { avgSimilarity: 0.92 });
    const result = discoverRelationshipCandidates([issue1, issue2], [cluster]);

    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.labelOverlap).toEqual(["auth", "bug", "security"]);
    expect(candidate.evidenceFactors).toContain("label_overlap");
    expect(candidate.evidenceTier).toBe("STRONG");
  });
});
