// Deterministic PR/issue relational classification for a duplicate cluster.
// Composition labels come from member types alone; the linked/unlinked split
// needs every member PR to carry closesIssues, because that field is absent on
// items scanned before it existed and absent must never read as "closes nothing".
import type { PRItem } from "./types.js";

export type ClusterRelation = "pr-issue-linked" | "pr-issue-unlinked" | "prs-only" | "issues-only";

export interface ClosingEdge {
  pr: number;
  issue: number;
}

export interface ClusterRelationResult {
  /** Absent when any member PR predates closesIssues — unknown, not unlinked. */
  relation?: ClusterRelation;
  closingEdges: ClosingEdge[];
}

export function classifyClusterRelation(items: PRItem[]): ClusterRelationResult {
  const prs = items.filter((i) => i.type === "pr");
  const issues = items.filter((i) => i.type === "issue");

  if (issues.length === 0) return { relation: "prs-only", closingEdges: [] };
  if (prs.length === 0) return { relation: "issues-only", closingEdges: [] };

  if (prs.some((pr) => pr.closesIssues === undefined)) {
    return { relation: undefined, closingEdges: [] };
  }

  const issueKeys = new Set(issues.map((i) => `${i.repo}#${i.number}`));
  const closingEdges: ClosingEdge[] = [];
  for (const pr of prs) {
    for (const closed of pr.closesIssues ?? []) {
      if (issueKeys.has(`${pr.repo}#${closed}`)) {
        closingEdges.push({ pr: pr.number, issue: closed });
      }
    }
  }
  closingEdges.sort((a, b) => a.pr - b.pr || a.issue - b.issue);

  return {
    relation: closingEdges.length > 0 ? "pr-issue-linked" : "pr-issue-unlinked",
    closingEdges,
  };
}
