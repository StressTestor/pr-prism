import { describe, expect, it } from "vitest";
import type { CanonicalCandidate } from "../canonical.js";
import { decideCanonical, ISSUE_TIE_WINDOW_MS, selectCanonical, TIE_MARGIN } from "../canonical.js";

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

describe("decideCanonical", () => {
  it("canonical always equals selectCanonical for the same input", () => {
    const items = [
      c({ number: 1, type: "issue", createdAt: "2026-01-02T00:00:00Z", score: 0.9 }),
      c({ number: 2, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.1 }),
      c({ number: 3, type: "pr", score: 0.99 }),
    ];
    expect(decideCanonical(items).canonical.number).toBe(selectCanonical(items).number);
  });

  it("PR-majority: contested when the top two scores are within TIE_MARGIN", () => {
    const near = [c({ number: 1, type: "pr", score: 0.61 }), c({ number: 2, type: "pr", score: 0.6 })];
    const d = decideCanonical(near);
    expect(d.canonical.number).toBe(1);
    expect(d.runnerUp?.number).toBe(2);
    expect(d.contested).toBe(true);
    expect(TIE_MARGIN).toBe(0.05);
  });

  it("PR-majority: not contested when the score gap exceeds TIE_MARGIN", () => {
    const clear = [c({ number: 1, type: "pr", score: 0.7 }), c({ number: 2, type: "pr", score: 0.5 })];
    expect(decideCanonical(clear).contested).toBe(false);
  });

  it("issue-majority: contested when the two earliest reports are within the tie window, even with far-apart scores", () => {
    // The core bug: old score-margin logic returned NOT contested here.
    const sixHours = 6 * 60 * 60 * 1000;
    const base = Date.parse("2026-03-01T00:00:00Z");
    const items = [
      c({ number: 10, type: "issue", createdAt: new Date(base).toISOString(), score: 0.1 }),
      c({ number: 11, type: "issue", createdAt: new Date(base + sixHours).toISOString(), score: 0.9 }),
    ];
    const d = decideCanonical(items);
    expect(d.canonical.number).toBe(10); // earliest report
    expect(d.runnerUp?.number).toBe(11); // second-earliest, not second-highest-score
    expect(d.contested).toBe(true);
  });

  it("issue-majority: not contested when the reports are far apart in time, even with near-equal scores", () => {
    // The inverse bug: old score-margin logic returned contested here.
    const base = Date.parse("2026-01-01T00:00:00Z");
    const items = [
      c({ number: 20, type: "issue", createdAt: new Date(base).toISOString(), score: 0.5 }),
      c({
        number: 21,
        type: "issue",
        createdAt: new Date(base + 30 * 24 * 60 * 60 * 1000).toISOString(),
        score: 0.48,
      }),
    ];
    expect(decideCanonical(items).contested).toBe(false);
    expect(ISSUE_TIE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("issue-majority: contested when both reports have equal or missing createdAt (coin flip)", () => {
    const equal = [
      c({ number: 30, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.9 }),
      c({ number: 31, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.1 }),
    ];
    expect(decideCanonical(equal).contested).toBe(true);
    const missing = [
      c({ number: 40, type: "issue", createdAt: undefined, score: 0.9 }),
      c({ number: 41, type: "issue", createdAt: undefined, score: 0.1 }),
    ];
    expect(decideCanonical(missing).contested).toBe(true);
  });

  it("issue-majority: not contested when only one report is dated (dated one is a clear original)", () => {
    const items = [
      c({ number: 50, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.1 }),
      c({ number: 51, type: "issue", createdAt: undefined, score: 0.9 }),
    ];
    const d = decideCanonical(items);
    expect(d.canonical.number).toBe(50);
    expect(d.contested).toBe(false);
  });

  it("single item: runnerUp is null and not contested", () => {
    const d = decideCanonical([c({ number: 1, type: "pr", score: 0.5 })]);
    expect(d.runnerUp).toBeNull();
    expect(d.contested).toBe(false);
  });

  it("throws on an empty candidate list", () => {
    expect(() => decideCanonical([])).toThrow();
  });

  it("PR-mode: a merged canonical over an open runner-up is a clear winner, not contested", () => {
    const items = [
      c({ number: 1, type: "pr", state: "open", score: 0.95 }),
      c({ number: 2, type: "pr", state: "merged", score: 0.4 }),
    ];
    const d = decideCanonical(items);
    expect(d.canonical.number).toBe(2);
    expect(d.contested).toBe(false); // decided by lifecycle state, not a score coin flip
  });
});

describe("selectCanonical state preference (merged PRs are the source of truth)", () => {
  it("PR-majority: a merged PR wins canonical over a higher-scored open PR", () => {
    const items = [
      c({ number: 1, type: "pr", state: "open", score: 0.9 }),
      c({ number: 2, type: "pr", state: "merged", score: 0.4 }),
    ];
    expect(selectCanonical(items).number).toBe(2);
  });

  it("state priority is merged > open > closed-unmerged at equal score", () => {
    const openVsClosed = [
      c({ number: 1, type: "pr", state: "closed", score: 0.5 }),
      c({ number: 2, type: "pr", state: "open", score: 0.5 }),
    ];
    expect(selectCanonical(openVsClosed).number).toBe(2); // open beats closed-unmerged
    const mergedVsOpen = [
      c({ number: 3, type: "pr", state: "open", score: 0.9 }),
      c({ number: 4, type: "pr", state: "merged", score: 0.9 }),
    ];
    expect(selectCanonical(mergedVsOpen).number).toBe(4);
  });

  it("no-state candidates resolve exactly as before (triage fall-through)", () => {
    const items = [c({ number: 1, type: "pr", score: 0.5 }), c({ number: 2, type: "pr", score: 0.9 })];
    expect(selectCanonical(items).number).toBe(2); // highest score, unchanged
  });

  it("issue-majority still picks the earliest report even when a merged PR is present", () => {
    const items = [
      c({ number: 1, type: "issue", createdAt: "2026-01-01T00:00:00Z", score: 0.1 }),
      c({ number: 2, type: "issue", createdAt: "2026-02-01T00:00:00Z", score: 0.9 }),
      c({ number: 3, type: "pr", state: "merged", createdAt: "2026-03-01T00:00:00Z", score: 0.99 }),
    ];
    expect(selectCanonical(items).number).toBe(1); // merged-preference is PR-mode only
  });
});
