import { describe, expect, it } from "vitest";
import type { DupeMatch } from "../format.js";
import { formatTriageComment } from "../format.js";

function match(number: number, title: string, similarity = 0.9): DupeMatch {
  return { number, type: "pr", title, similarity };
}

describe("formatTriageComment", () => {
  it("escapes a malicious title so it cannot inject extra table rows", () => {
    const evil = match(42, "evil | title\n| 999 | 100% | pwned");
    const comment = formatTriageComment("o/r", [evil], evil, 12);
    // The injected row would appear as its own line if the newline survived.
    expect(comment.split("\n")).not.toContain("| 999 | 100% | pwned |");
    expect(comment).toContain("\\|"); // the pipe got escaped, not left bare
    // exactly one match data row (the link line), not a smuggled second
    expect(comment.split("\n").filter((l) => l.startsWith("| [#")).length).toBe(1);
  });

  it("renders a benign title unchanged in the row", () => {
    const clean = match(7, "fix: handle null endpoint");
    const comment = formatTriageComment("o/r", [clean], clean, 5);
    expect(comment).toContain("fix: handle null endpoint");
  });
});
