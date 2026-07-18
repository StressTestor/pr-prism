import { describe, expect, it } from "vitest";
import { classifyClusterRelation } from "../relations.js";
import type { PRItem } from "../types.js";

function item(number: number, type: "pr" | "issue", over: Partial<PRItem> = {}): PRItem {
  return {
    number,
    type,
    repo: "owner/repo",
    title: `item ${number}`,
    body: "",
    state: "open",
    author: "someone",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [],
    ...over,
  };
}

describe("classifyClusterRelation", () => {
  it("labels a PR+issue cluster with an in-cluster closing edge as pr-issue-linked", () => {
    const result = classifyClusterRelation([item(10, "pr", { closesIssues: [7] }), item(7, "issue")]);
    expect(result.relation).toBe("pr-issue-linked");
    expect(result.closingEdges).toEqual([{ pr: 10, issue: 7 }]);
  });

  it("labels a PR+issue cluster with no in-cluster closing edge as pr-issue-unlinked", () => {
    const result = classifyClusterRelation([item(10, "pr", { closesIssues: [] }), item(7, "issue")]);
    expect(result.relation).toBe("pr-issue-unlinked");
    expect(result.closingEdges).toEqual([]);
  });

  it("out-of-cluster closing refs do not make a cluster linked", () => {
    const result = classifyClusterRelation([item(10, "pr", { closesIssues: [999] }), item(7, "issue")]);
    expect(result.relation).toBe("pr-issue-unlinked");
    expect(result.closingEdges).toEqual([]);
  });

  it("labels an all-PR cluster prs-only even when closesIssues is unknown", () => {
    const result = classifyClusterRelation([item(10, "pr"), item(11, "pr")]);
    expect(result.relation).toBe("prs-only");
    expect(result.closingEdges).toEqual([]);
  });

  it("labels an all-issue cluster issues-only", () => {
    const result = classifyClusterRelation([item(7, "issue"), item(8, "issue")]);
    expect(result.relation).toBe("issues-only");
    expect(result.closingEdges).toEqual([]);
  });

  it("omits relation for a mixed cluster when any PR predates the closesIssues field", () => {
    const result = classifyClusterRelation([
      item(10, "pr", { closesIssues: [7] }),
      item(11, "pr"), // scanned before the field existed: unknown, not empty
      item(7, "issue"),
    ]);
    expect(result.relation).toBeUndefined();
    expect(result.closingEdges).toEqual([]);
  });

  it("resolves one edge per closed in-cluster issue and sorts deterministically", () => {
    const result = classifyClusterRelation([
      item(12, "pr", { closesIssues: [8, 7] }),
      item(10, "pr", { closesIssues: [7] }),
      item(7, "issue"),
      item(8, "issue"),
    ]);
    expect(result.relation).toBe("pr-issue-linked");
    expect(result.closingEdges).toEqual([
      { pr: 10, issue: 7 },
      { pr: 12, issue: 7 },
      { pr: 12, issue: 8 },
    ]);
  });

  it("does not match closing refs across repos in a multi-repo cluster", () => {
    const result = classifyClusterRelation([
      item(10, "pr", { closesIssues: [7], repo: "owner/alpha" }),
      item(7, "issue", { repo: "owner/beta" }),
    ]);
    expect(result.relation).toBe("pr-issue-unlinked");
    expect(result.closingEdges).toEqual([]);
  });

  it("never fabricates an edge to a PR member sharing the closed number", () => {
    // GitHub numbers PRs and issues from one sequence; a closes ref is always an
    // issue, so a same-number PR member must not resolve as an edge target.
    const result = classifyClusterRelation([
      item(10, "pr", { closesIssues: [11] }),
      item(11, "pr", { closesIssues: [] }),
      item(7, "issue"),
    ]);
    expect(result.relation).toBe("pr-issue-unlinked");
    expect(result.closingEdges).toEqual([]);
  });
});
