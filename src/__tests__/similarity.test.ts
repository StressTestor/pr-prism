import { describe, expect, it } from "vitest";
import { cosineSimilarity, isZeroVector } from "../similarity.js";

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

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("works with number arrays", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it("returns negative for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });
});

describe("isZeroVector", () => {
  it("returns true for zero vector", () => {
    expect(isZeroVector(new Float32Array([0, 0, 0]))).toBe(true);
  });

  it("returns false for non-zero vector", () => {
    expect(isZeroVector(new Float32Array([0, 0.1, 0]))).toBe(false);
  });

  it("returns true for empty vector", () => {
    expect(isZeroVector(new Float32Array(0))).toBe(true);
  });

  it("works with number arrays", () => {
    expect(isZeroVector([0, 0, 0])).toBe(true);
    expect(isZeroVector([0, 1, 0])).toBe(false);
  });
});
