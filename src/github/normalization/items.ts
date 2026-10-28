import type { PRItem } from "../../types.js";
import { accountIsBot } from "./bot.js";
import { mapCIStatus } from "./ci.js";
import { itemClosedAt } from "./closed-at.js";
import { mapClosingIssues } from "./issues.js";
import { restPRState } from "./pr-state.js";
import { determineHasTests } from "./test-files.js";

export function normalizeGraphQLPR(pr: any, repoFull: string): PRItem {
  const fileNodes: string[] = (pr.files?.nodes || []).map((f: any) => f.path);
  const fileTotalCount: number = pr.files?.totalCount || 0;
  const hasTests = determineHasTests(fileNodes, fileTotalCount);
  const ciRollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;

  return {
    number: pr.number,
    type: "pr",
    repo: repoFull,
    title: pr.title,
    body: pr.body || "",
    state: pr.state.toLowerCase(),
    author: pr.author?.login || "unknown",
    authorIsBot: accountIsBot(pr.author),
    createdAt: pr.createdAt,
    closedAt: itemClosedAt(pr),
    nodeId: pr.id,
    headRefOid: pr.headRefOid,
    updatedAt: pr.updatedAt,
    labels: (pr.labels?.nodes || []).map((l: any) => l.name),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    ciStatus: mapCIStatus(ciRollup),
    reviewCount: pr.reviews?.totalCount || 0,
    hasTests,
    closesIssues: mapClosingIssues(pr.closingIssuesReferences, repoFull),
  };
}

export function normalizeGraphQLIssue(issue: any, repoFull: string): PRItem {
  return {
    number: issue.number,
    type: "issue",
    repo: repoFull,
    title: issue.title,
    body: issue.body || "",
    state: issue.state.toLowerCase(),
    author: issue.author?.login || "unknown",
    authorIsBot: accountIsBot(issue.author),
    createdAt: issue.createdAt,
    closedAt: itemClosedAt(issue),
    nodeId: issue.id,
    updatedAt: issue.updatedAt,
    labels: (issue.labels?.nodes || []).map((l: any) => l.name),
  };
}

export function normalizeRestPR(pr: any, repoFull: string): PRItem {
  return {
    number: pr.number,
    type: "pr",
    repo: repoFull,
    title: pr.title,
    body: pr.body || "",
    state: restPRState(pr),
    author: pr.user?.login || "unknown",
    authorIsBot: accountIsBot(pr.user),
    createdAt: pr.created_at,
    closedAt: itemClosedAt(pr),
    nodeId: pr.node_id,
    headRefOid: pr.head?.sha,
    updatedAt: pr.updated_at,
    labels: pr.labels ? pr.labels.map((l: any) => (typeof l === "string" ? l : l.name || "")) : [],
    diffUrl: pr.diff_url,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
  };
}

export function normalizeRestIssue(issue: any, repoFull: string): PRItem {
  return {
    number: issue.number,
    type: "issue",
    repo: repoFull,
    title: issue.title,
    body: issue.body || "",
    state: issue.state,
    author: issue.user?.login || "unknown",
    authorIsBot: accountIsBot(issue.user),
    createdAt: issue.created_at,
    closedAt: itemClosedAt(issue),
    nodeId: issue.node_id,
    updatedAt: issue.updated_at,
    labels: issue.labels ? issue.labels.map((l: any) => (typeof l === "string" ? l : l.name || "")) : [],
  };
}
