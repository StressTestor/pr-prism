import { describe, expect, it } from "vitest";
import { computeClusterOverlap } from "../benchmark.js";

interface SimpleCluster {
  id: number;
  items: number[];
}

describe("computeClusterOverlap", () => {
  it("returns 100% for identical clusters", () => {
    const a: SimpleCluster[] = [
      { id: 1, items: [1, 2, 3] },
      { id: 2, items: [4, 5] },
    ];
    const b: SimpleCluster[] = [
      { id: 1, items: [1, 2, 3] },
      { id: 2, items: [4, 5] },
    ];
    const result = computeClusterOverlap(a, b);
    expect(result.overlapPercent).toBe(100);
    expect(result.uniqueToA).toBe(0);
    expect(result.uniqueToB).toBe(0);
  });

  it("returns 0% for completely disjoint clusters", () => {
    const a: SimpleCluster[] = [{ id: 1, items: [1, 2, 3] }];
    const b: SimpleCluster[] = [{ id: 1, items: [4, 5, 6] }];
    const result = computeClusterOverlap(a, b);
    expect(result.overlapPercent).toBe(0);
  });

  it("handles partial overlap", () => {
    const a: SimpleCluster[] = [{ id: 1, items: [1, 2, 3, 4] }];
    const b: SimpleCluster[] = [{ id: 1, items: [2, 3, 4, 5] }];
    const result = computeClusterOverlap(a, b);
    // Jaccard: intersection{2,3,4}=3, union{1,2,3,4,5}=5 -> 60%
    expect(result.overlapPercent).toBe(60);
  });

  it("handles different cluster counts", () => {
    const a: SimpleCluster[] = [
      { id: 1, items: [1, 2] },
      { id: 2, items: [3, 4] },
      { id: 3, items: [5, 6] },
    ];
    const b: SimpleCluster[] = [{ id: 1, items: [1, 2, 3, 4] }];
    const result = computeClusterOverlap(a, b);
    expect(result.uniqueToA).toBeGreaterThan(0);
  });

  it("handles empty input (0 clusters both sides)", () => {
    const result = computeClusterOverlap([], []);
    expect(result.overlapPercent).toBe(100);
    expect(result.uniqueToA).toBe(0);
    expect(result.uniqueToB).toBe(0);
  });

  it("handles one side empty", () => {
    const a: SimpleCluster[] = [{ id: 1, items: [1, 2, 3] }];
    const result = computeClusterOverlap(a, []);
    expect(result.overlapPercent).toBe(0);
    expect(result.uniqueToA).toBe(1);
    expect(result.uniqueToB).toBe(0);
  });
});
