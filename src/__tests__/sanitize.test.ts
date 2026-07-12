import { describe, expect, it } from "vitest";
import { escapeTableCell, sanitizeTitle, stripControlChars } from "../sanitize.js";

const ESC = String.fromCharCode(27); // ANSI escape
const BEL = String.fromCharCode(7); // bell

describe("stripControlChars", () => {
  it("replaces newlines/tabs/returns with a space, collapses runs, trims", () => {
    expect(stripControlChars("a\nb\tc\r  d")).toBe("a b c d");
    expect(stripControlChars("  hi  ")).toBe("hi");
  });

  it("strips the ANSI escape byte and other control chars", () => {
    const out = stripControlChars(`a${ESC}[31mred${BEL}`);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).toContain("red");
  });

  it("leaves clean ASCII unchanged", () => {
    expect(stripControlChars("fix: handle null endpoint")).toBe("fix: handle null endpoint");
  });
});

describe("sanitizeTitle", () => {
  it("strips control chars and caps length (default 256)", () => {
    expect(sanitizeTitle("a\nb")).toBe("a b");
    expect(sanitizeTitle("x".repeat(500))).toHaveLength(256);
    expect(sanitizeTitle("x".repeat(500), 10)).toHaveLength(10);
  });
});

describe("escapeTableCell", () => {
  it("removes newlines and escapes pipes so a title can't inject a table row", () => {
    const out = escapeTableCell("evil | title\n| 999 | 100% | pwned", 100);
    expect(out).not.toContain("\n");
    expect(out).not.toMatch(/(?<!\\)\|/); // no unescaped pipe survives
  });

  it("truncates to maxLength", () => {
    expect(escapeTableCell("x".repeat(100), 10)).toHaveLength(10);
  });

  it("never leaves a dangling trailing backslash at the cut boundary", () => {
    expect(escapeTableCell("abc\\", 60).endsWith("\\")).toBe(false);
    expect(escapeTableCell("abcdefghi|jkl", 9).endsWith("\\")).toBe(false);
  });

  it("passes clean text through unchanged", () => {
    expect(escapeTableCell("fix: handle null")).toBe("fix: handle null");
  });
});
