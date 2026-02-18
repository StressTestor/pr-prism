import { describe, expect, it } from "vitest";
import type { PrismConfig } from "../config.js";
import { scorePR } from "../scorer.js";
import type { PRItem } from "../types.js";

function makeConfig(overrides = {}): PrismConfig {
  return {
    repo: "test/repo",
    thresholds: { duplicate_similarity: 0.85, aligned: 0.65, drifting: 0.4 },
    scoring: {
      weights: {
        has_tests: 0.25,
        ci_passing: 0.2,
        diff_size_penalty: 0.15,
        author_history: 0.15,
        description_quality: 0.15,
        review_approvals: 0.1,
      },
    },
    labels: {
      duplicate: "prism:duplicate",
      aligned: "prism:aligned",
      drifting: "prism:drifting",
      off_vision: "prism:off-vision",
      top_pick: "prism:top-pick",
    },
    batch_size: 50,
    max_prs: 5000,
    ...overrides,
  } as PrismConfig;
}

function makePR(overrides = {}): PRItem {
  return {
    number: 1,
    type: "pr",
    repo: "test/repo",
    title: "Test PR",
    body: "A good description that is long enough to score well in the quality check",
    state: "open",
    author: "testuser",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    labels: [],
    additions: 50,
    deletions: 10,
    ...overrides,
  };
}

describe("scorePR", () => {
  const config = makeConfig();
  const context = { authorMergeCounts: new Map([["testuser", 10]]) };

  it("returns a score between 0 and 2", () => {
    const result = scorePR(makePR(), config, context);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(2);
  });

  it("scores CI success higher than failure", () => {
    const success = scorePR(makePR({ ciStatus: "success" }), config, context);
    const failure = scorePR(makePR({ ciStatus: "failure" }), config, context);
    expect(success.score).toBeGreaterThan(failure.score);
  });

  it("scores hasTests true higher than false", () => {
    const withTests = scorePR(makePR({ hasTests: true }), config, context);
    const noTests = scorePR(makePR({ hasTests: false }), config, context);
    expect(withTests.score).toBeGreaterThan(noTests.score);
  });

  it("scores smaller diffs higher", () => {
    const small = scorePR(makePR({ additions: 10, deletions: 5 }), config, context);
    const large = scorePR(makePR({ additions: 5000, deletions: 5000 }), config, context);
    expect(small.score).toBeGreaterThan(large.score);
  });

  it("redistributes weights when diff stats missing", () => {
    const noDiff = scorePR(makePR({ additions: undefined, deletions: undefined }), config, context);
    expect(noDiff.signals.diffSize).toBe(-1);
    expect(noDiff.score).toBeGreaterThan(0);
  });

  it("includes recency in score", () => {
    const recent = scorePR(makePR({ updatedAt: new Date().toISOString() }), config, context);
    const old = scorePR(makePR({ updatedAt: "2020-01-01T00:00:00Z" }), config, context);
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it("uses reviewCount for review approvals signal", () => {
    const reviewed = scorePR(makePR({ reviewCount: 3 }), config, context);
    const unreviewed = scorePR(makePR({ reviewCount: 0 }), config, context);
    expect(reviewed.signals.reviewApprovals).toBe(1.0);
    expect(unreviewed.signals.reviewApprovals).toBe(0);
  });
});
