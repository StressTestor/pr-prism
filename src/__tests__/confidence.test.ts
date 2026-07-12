import { describe, expect, it } from "vitest";
import { CONFIDENCE_HIGH_MIN, CONFIDENCE_SOLID_MIN, confidenceTier } from "../confidence.js";

describe("confidenceTier", () => {
  it("returns high at and above the high threshold", () => {
    expect(confidenceTier(1)).toBe("high");
    expect(confidenceTier(0.95)).toBe("high");
    expect(confidenceTier(0.9)).toBe("high");
  });

  it("returns solid between the solid and high thresholds", () => {
    expect(confidenceTier(0.89)).toBe("solid");
    expect(confidenceTier(0.8)).toBe("solid");
  });

  it("returns loose below the solid threshold", () => {
    expect(confidenceTier(0.799)).toBe("loose");
    expect(confidenceTier(0)).toBe("loose");
  });

  it("treats NaN as loose (both comparisons fail)", () => {
    expect(confidenceTier(Number.NaN)).toBe("loose");
  });

  it("exposes the thresholds as named constants that drive the tiering", () => {
    expect(CONFIDENCE_HIGH_MIN).toBe(0.9);
    expect(CONFIDENCE_SOLID_MIN).toBe(0.8);
    expect(confidenceTier(CONFIDENCE_HIGH_MIN)).toBe("high");
    expect(confidenceTier(CONFIDENCE_SOLID_MIN)).toBe("solid");
  });
});

describe("confidenceTier re-export (backward-compat)", () => {
  it("is still importable from starmap.js and identical", async () => {
    const { confidenceTier: viaStarmap } = await import("../starmap.js");
    expect(viaStarmap(0.9)).toBe("high");
    expect(viaStarmap(0.85)).toBe("solid");
    expect(viaStarmap(0.5)).toBe("loose");
  });
});
