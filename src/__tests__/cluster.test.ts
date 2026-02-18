import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../cluster.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 2]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("handles high-dimensional vectors", () => {
    const dim = 1536;
    const a = new Float32Array(dim).fill(1);
    const b = new Float32Array(dim).fill(1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });
});
