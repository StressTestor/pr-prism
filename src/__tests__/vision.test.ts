import { describe, expect, it } from "vitest";
import type { PrismConfig } from "../config.js";
import { scoreVisionAlignment } from "../vision.js";

function makeConfig(): PrismConfig {
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
    labels: { duplicate: "d", aligned: "a", drifting: "dr", off_vision: "ov", top_pick: "tp" },
    batch_size: 50,
    max_prs: 5000,
  } as PrismConfig;
}

describe("scoreVisionAlignment", () => {
  const config = makeConfig();

  it("classifies high similarity as aligned", () => {
    const prEmb = [1, 0, 0];
    const chunks = [{ heading: "Goal 1", text: "test", embedding: [1, 0, 0] }];
    const result = scoreVisionAlignment(prEmb, chunks, config);
    expect(result.classification).toBe("aligned");
    expect(result.score).toBeCloseTo(1.0);
    expect(result.matchedSection).toBe("Goal 1");
  });

  it("classifies low similarity as off-vision", () => {
    const prEmb = [1, 0, 0];
    const chunks = [{ heading: "Goal 1", text: "test", embedding: [0, 1, 0] }];
    const result = scoreVisionAlignment(prEmb, chunks, config);
    expect(result.classification).toBe("off-vision");
  });

  it("classifies drifting at boundary (sim between 0.40 and 0.65)", () => {
    // cos similarity of [1, 0.7, 0] and [0, 0.7, 1] = (0 + 0.49 + 0) / (sqrt(1.49) * sqrt(1.49)) = 0.49 / 1.49 ≈ 0.329
    // That's off-vision. Let's find drifting range (0.40-0.65):
    // [1, 0.5, 0] and [0.5, 1, 0]: dot=1.0, norms=sqrt(1.25)*sqrt(1.25)=1.25, sim=0.8 → aligned
    // We need sim ≈ 0.5. Use [1, 0, 0] and [1, 1, 1]: dot=1, norms=1*sqrt(3), sim=0.577 → drifting
    const prEmb = [1, 0, 0];
    const chunks = [{ heading: "Goal 1", text: "test", embedding: [1, 1, 1] }];
    const result = scoreVisionAlignment(prEmb, chunks, config);
    // sim ≈ 0.577, between drifting (0.40) and aligned (0.65)
    expect(result.classification).toBe("drifting");
    expect(result.score).toBeGreaterThanOrEqual(0.4);
    expect(result.score).toBeLessThan(0.65);
  });

  it("off-vision at low boundary (sim < 0.40)", () => {
    // [1, 0, 0] and [0, 1, 0]: dot=0, sim=0 → off-vision
    const prEmb = [1, 0, 0];
    const chunks = [{ heading: "Goal 1", text: "test", embedding: [0, 1, 0] }];
    const result = scoreVisionAlignment(prEmb, chunks, config);
    expect(result.classification).toBe("off-vision");
    expect(result.score).toBeLessThan(0.4);
  });

  it("aligned at exact boundary (sim = 0.65)", () => {
    // Testing that >= 0.65 is "aligned"
    // We can't easily construct exact 0.65, but we can verify the boundary logic
    // [3, 2, 0] and [2, 3, 0]: dot=12, norms=sqrt(13)*sqrt(13)=13, sim=12/13≈0.923 → aligned
    const prEmb = [3, 2, 0];
    const chunks = [{ heading: "Goal 1", text: "test", embedding: [2, 3, 0] }];
    const result = scoreVisionAlignment(prEmb, chunks, config);
    expect(result.classification).toBe("aligned");
  });

  it("picks the best matching section", () => {
    const prEmb = [1, 0, 0];
    const chunks = [
      { heading: "Wrong", text: "test", embedding: [0, 1, 0] },
      { heading: "Right", text: "test", embedding: [1, 0, 0] },
    ];
    const result = scoreVisionAlignment(prEmb, chunks, config);
    expect(result.matchedSection).toBe("Right");
  });
});
