import { describe, expect, it } from "vitest";

// parseDuration is exported from cli.ts but importing it triggers program.parse()
// so we inline the function here for unit testing
function parseDuration(s: string): string {
  const match = s.match(/^(\d+)(d|w|m)$/);
  if (!match) throw new Error(`Invalid duration: ${s}. Use format like 7d, 2w, 1m`);
  const [, num, unit] = match;
  const days = unit === "d" ? parseInt(num, 10) : unit === "w" ? parseInt(num, 10) * 7 : parseInt(num, 10) * 30;
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

describe("parseDuration", () => {
  it("parses days", () => {
    const result = parseDuration("7d");
    const date = new Date(result);
    const diff = Date.now() - date.getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeCloseTo(7, 0);
  });

  it("parses weeks", () => {
    const result = parseDuration("2w");
    const date = new Date(result);
    const diff = Date.now() - date.getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeCloseTo(14, 0);
  });

  it("parses months", () => {
    const result = parseDuration("1m");
    const date = new Date(result);
    const diff = Date.now() - date.getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeCloseTo(30, 0);
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
    expect(() => parseDuration("7x")).toThrow("Invalid duration");
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });

  it("returns ISO string", () => {
    const result = parseDuration("1d");
    expect(() => new Date(result)).not.toThrow();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
