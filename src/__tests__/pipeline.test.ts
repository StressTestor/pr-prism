import { describe, expect, it } from "vitest";
import { parseDuration } from "../pipeline.js";

describe("parseDuration", () => {
  it("parses days", () => {
    const result = parseDuration("7d");
    const date = new Date(result);
    const expected = new Date();
    expected.setDate(expected.getDate() - 7);
    expect(Math.abs(date.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("parses weeks", () => {
    const result = parseDuration("2w");
    const date = new Date(result);
    const expected = new Date();
    expected.setDate(expected.getDate() - 14);
    expect(Math.abs(date.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("parses months", () => {
    const result = parseDuration("1m");
    const date = new Date(result);
    const expected = new Date();
    expected.setDate(expected.getDate() - 30);
    expect(Math.abs(date.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
    expect(() => parseDuration("7x")).toThrow("Invalid duration");
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });
});

describe("pipeline exports", () => {
  it("exports key pipeline functions", async () => {
    const mod = await import("../pipeline.js");
    expect(typeof mod.createPipelineContext).toBe("function");
    expect(typeof mod.runScan).toBe("function");
    expect(typeof mod.runDupes).toBe("function");
    expect(typeof mod.runRank).toBe("function");
    expect(typeof mod.runVision).toBe("function");
    expect(typeof mod.runCompare).toBe("function");
    expect(typeof mod.resolveRepos).toBe("function");
  });
});
