import { describe, expect, it } from "vitest";
import type { CanonicalCandidate } from "../canonical.js";
import { selectCanonical } from "../canonical.js";

// Minimal candidates: selectCanonical only needs type/createdAt/score/number
// (+ optional reviewCount), decoupled from ScoredPR/DupeMatch so both callers
// can share it.
function c(partial: Partial<CanonicalCandidate> & { number: number }): CanonicalCandidate {
  return {
    type: "pr",
    createdAt: "2026-01-01T00:00:00Z",
    score: 0,
    ...partial,
  };
}

describe("selectCanonical", () => {
  it("issue-majority cluster picks the earliest report, not the highest score", () => {
    const items = [
      c({ number: 10, type: "issue", createdAt: "2026-01-02T00:00:00Z", score: 0.9 }),
      c({ number: 11, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.1 }),
      c({ number: 12, type: "pr", createdAt: "2026-01-03T00:00:00Z", score: 0.99 }),
    ];
    expect(selectCanonical(items).number).toBe(11);
  });

  it("PR-majority cluster picks the highest quality score", () => {
    const items = [
      c({ number: 20, type: "pr", createdAt: "2026-01-01T00:00:00Z", score: 0.5 }),
      c({ number: 21, type: "pr", createdAt: "2026-01-05T00:00:00Z", score: 0.9 }),
      c({ number: 22, type: "issue", createdAt: "2026-01-02T00:00:00Z", score: 0.7 }),
    ];
    expect(selectCanonical(items).number).toBe(21);
  });

  it("mode:'issue' override forces earliest even in a PR-majority set", () => {
    const items = [
      c({ number: 20, type: "pr", createdAt: "2026-01-01T00:00:00Z", score: 0.5 }),
      c({ number: 21, type: "pr", createdAt: "2026-01-05T00:00:00Z", score: 0.9 }),
      c({ number: 22, type: "issue", createdAt: "2026-01-02T00:00:00Z", score: 0.7 }),
    ];
    expect(selectCanonical(items, { mode: "issue" }).number).toBe(20);
  });

  it("mode:'pr' override forces highest score even in an issue-majority set", () => {
    const items = [
      c({ number: 10, type: "issue", createdAt: "2026-01-02T00:00:00Z", score: 0.9 }),
      c({ number: 11, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.1 }),
      c({ number: 12, type: "pr", createdAt: "2026-01-03T00:00:00Z", score: 0.99 }),
    ];
    expect(selectCanonical(items, { mode: "pr" }).number).toBe(12);
  });

  it("is deterministic on full ties, breaking to the lowest number regardless of input order", () => {
    const a = c({ number: 31, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.5 });
    const b = c({ number: 30, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.5 });
    expect(selectCanonical([a, b]).number).toBe(30);
    expect(selectCanonical([b, a]).number).toBe(30);
  });

  it("PR mode breaks a score+date tie by review count", () => {
    const items = [
      c({ number: 50, type: "pr", createdAt: "2026-01-01T00:00:00Z", score: 0.5, reviewCount: 1 }),
      c({ number: 51, type: "pr", createdAt: "2026-01-01T00:00:00Z", score: 0.5, reviewCount: 5 }),
    ];
    expect(selectCanonical(items).number).toBe(51);
  });

  it("treats a missing/invalid createdAt as never-earliest (triage's DupeMatch case)", () => {
    const items = [
      c({ number: 40, type: "issue", createdAt: undefined, score: 0.9 }),
      c({ number: 41, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.1 }),
    ];
    expect(selectCanonical(items).number).toBe(41);
  });

  it("does not mutate the caller's array order", () => {
    const items = [c({ number: 60, type: "pr", score: 0.1 }), c({ number: 61, type: "pr", score: 0.9 })];
    selectCanonical(items);
    expect(items.map((i) => i.number)).toEqual([60, 61]);
  });

  it("throws on an empty candidate list", () => {
    expect(() => selectCanonical([])).toThrow();
  });
});
