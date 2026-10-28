import type { MaintainerItem } from "./types.js";

export interface BacklogReport {
  generatedAt: string;
  repo: string;
  summary: {
    totalOpen: number;
    totalClosed: number;
    prs: number;
    issues: number;
    duplicateCandidates: number;
    confirmedDuplicates: number;
    needingInfo: number;
    escalatedForReview: number;
    reviewed: number;
  };
  prioritizedPrs: MaintainerItem[];
  prioritizedIssues: MaintainerItem[];
  duplicateCandidates: MaintainerItem[];
  awaitingDecision: MaintainerItem[];
  closureCandidates: MaintainerItem[];
  missingInfoItems: MaintainerItem[];
}

export interface ProgressReport {
  generatedAt: string;
  repo: string;
  byTier: { tier: string; total: number; reviewed: number; pending: number }[];
  staleEvidence: number;
  freshEvidence: number;
  noEvidence: number;
}

const DISCLAIMER_BANNER =
  "> Advisory data labeled [advisory] — source-backed facts labeled [source]\n> Model recommendations are advisory signals and not independently verified facts.";

const URGENCY_WEIGHTS: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function getUrgencyWeight(urgency: string | null | undefined): number {
  if (!urgency) return 0;
  return URGENCY_WEIGHTS[urgency.toLowerCase()] ?? 0;
}

function resolveGeneratedAt(items: MaintainerItem[], explicit?: string): string {
  if (explicit) return explicit;
  const timestamps = items
    .map((i) => i.updatedAt || i.createdAt)
    .filter(Boolean)
    .sort();
  if (timestamps.length > 0) {
    return timestamps[timestamps.length - 1];
  }
  return "2026-10-27T00:00:00.000Z";
}

function sortItemsDeterministically(items: MaintainerItem[]): MaintainerItem[] {
  return [...items].sort((a, b) => {
    // 1. Urgency descending
    const uA = getUrgencyWeight(a.urgency);
    const uB = getUrgencyWeight(b.urgency);
    if (uA !== uB) {
      return uB - uA;
    }
    // 2. Quality score descending
    const qA = a.qualityScore ?? -1;
    const qB = b.qualityScore ?? -1;
    if (qA !== qB) {
      return qB - qA;
    }
    // 3. Stable tie-breaker: number ascending
    return a.number - b.number;
  });
}

/**
 * Generate structured JSON backlog for dashboard integration.
 * Deterministic for identical input data.
 */
export function generateBacklogJson(
  items: MaintainerItem[],
  repo: string,
  options?: { generatedAt?: string },
): BacklogReport {
  const generatedAt = resolveGeneratedAt(items, options?.generatedAt);

  const totalOpen = items.filter((i) => i.state === "open").length;
  const totalClosed = items.filter((i) => i.state === "closed" || i.state === "merged").length;
  const prs = items.filter((i) => i.type === "pr").length;
  const issues = items.filter((i) => i.type === "issue").length;

  const duplicateCandidates = items.filter(
    (i) => i.isDuplicateCandidate || i.isConfirmedDuplicate || i.isSupersededCandidate,
  );
  const confirmedDuplicates = items.filter((i) => i.isConfirmedDuplicate).length;
  const needingInfo = items.filter((i) => i.missingInformation === true || i.suggestedAction === "request_info").length;
  const escalatedForReview = items.filter((i) => i.escalateToDeepReview === true).length;
  const reviewed = items.filter((i) => i.hasDeepReview === true || i.reviewRecommendation !== null).length;

  const prioritizedPrs = sortItemsDeterministically(items.filter((i) => i.type === "pr"));
  const prioritizedIssues = sortItemsDeterministically(items.filter((i) => i.type === "issue"));

  const duplicateCandidatesList = sortItemsDeterministically(duplicateCandidates);

  const awaitingDecision = sortItemsDeterministically(
    items.filter(
      (i) =>
        i.state === "open" &&
        (!i.hasJevDecision || i.jevDecisionAge === "none" || (i.escalateToDeepReview && !i.hasDeepReview)),
    ),
  );

  const closureCandidates = sortItemsDeterministically(
    items.filter(
      (i) =>
        i.state === "open" &&
        (i.suggestedAction === "close_duplicate" ||
          i.suggestedAction === "close_superseded" ||
          i.isConfirmedDuplicate ||
          i.isSupersededCandidate),
    ),
  );

  const missingInfoItems = sortItemsDeterministically(
    items.filter((i) => i.state === "open" && (i.missingInformation === true || i.suggestedAction === "request_info")),
  );

  return {
    generatedAt,
    repo,
    summary: {
      totalOpen,
      totalClosed,
      prs,
      issues,
      duplicateCandidates: duplicateCandidates.length,
      confirmedDuplicates,
      needingInfo,
      escalatedForReview,
      reviewed,
    },
    prioritizedPrs,
    prioritizedIssues,
    duplicateCandidates: duplicateCandidatesList,
    awaitingDecision,
    closureCandidates,
    missingInfoItems,
  };
}

/**
 * Generate Markdown backlog report.
 * Deterministic for identical input data.
 */
export function generateBacklogReport(items: MaintainerItem[], repo: string): string {
  const data = generateBacklogJson(items, repo);

  const lines: string[] = [
    `# Maintainer Backlog Report: ${repo}`,
    "",
    `**Generated:** ${data.generatedAt} [source] | **Repository:** ${repo} [source]`,
    "",
    DISCLAIMER_BANNER,
    "",
    "## Executive Summary",
    "",
    "| Metric | Count | Grounding |",
    "|---|---:|---|",
    `| Total Open Items | ${data.summary.totalOpen} | [source] |`,
    `| Total Closed / Merged | ${data.summary.totalClosed} | [source] |`,
    `| Pull Requests | ${data.summary.prs} | [source] |`,
    `| Issues | ${data.summary.issues} | [source] |`,
    `| Duplicate Candidates | ${data.summary.duplicateCandidates} | [advisory] |`,
    `| Confirmed Identity Duplicates | ${data.summary.confirmedDuplicates} | [source] |`,
    `| Items Needing Information | ${data.summary.needingInfo} | [advisory] |`,
    `| Escalated for Deep Review | ${data.summary.escalatedForReview} | [advisory] |`,
    `| Reviews Completed | ${data.summary.reviewed} | [source] |`,
    "",
    "## Prioritized Pull Requests",
    "",
  ];

  if (data.prioritizedPrs.length === 0) {
    lines.push("_No pull requests found._", "");
  } else {
    lines.push(
      "| # | Title | State | Urgency [advisory] | Category [advisory] | Score [source] | Suggested Action [advisory] |",
    );
    lines.push("|---:|---|---|---|---|---:|---|");
    for (const pr of data.prioritizedPrs) {
      const urgencyStr = pr.urgency ? `${pr.urgency} [advisory]` : "unassigned";
      const catStr = pr.category ? `${pr.category} [advisory]` : "unassigned";
      const scoreStr = pr.qualityScore !== null ? pr.qualityScore.toFixed(2) : "-";
      lines.push(
        `| #${pr.number} | ${pr.title} | ${pr.state} [source] | ${urgencyStr} | ${catStr} | ${scoreStr} | \`${pr.suggestedAction}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## Prioritized Issues", "");
  if (data.prioritizedIssues.length === 0) {
    lines.push("_No issues found._", "");
  } else {
    lines.push("| # | Title | State | Urgency [advisory] | Category [advisory] | Suggested Action [advisory] |");
    lines.push("|---:|---|---|---|---|---|");
    for (const issue of data.prioritizedIssues) {
      const urgencyStr = issue.urgency ? `${issue.urgency} [advisory]` : "unassigned";
      const catStr = issue.category ? `${issue.category} [advisory]` : "unassigned";
      lines.push(
        `| #${issue.number} | ${issue.title} | ${issue.state} [source] | ${urgencyStr} | ${catStr} | \`${issue.suggestedAction}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## Duplicate & Superseded Candidates", "");
  if (data.duplicateCandidates.length === 0) {
    lines.push("_No duplicate or superseded candidates identified._", "");
  } else {
    lines.push("| # | Type | Title | Match Type | Similarity | Suggested Action |");
    lines.push("|---:|---|---|---|---:|---|");
    for (const item of data.duplicateCandidates) {
      const matchType = item.isConfirmedDuplicate
        ? "Confirmed Identity Match [source]"
        : item.isSupersededCandidate
          ? "Superseded by Closed/Merged [source]"
          : "Fuzzy Candidate [advisory]";
      const simStr = item.clusterMinSimilarity !== null ? item.clusterMinSimilarity.toFixed(2) : "-";
      lines.push(
        `| #${item.number} | ${item.type} | ${item.title} | ${matchType} | ${simStr} | \`${item.suggestedAction}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## Items Needing Information", "");
  if (data.missingInfoItems.length === 0) {
    lines.push("_No items currently blocked on missing information._", "");
  } else {
    lines.push("| # | Type | Title | Suggested Action |");
    lines.push("|---:|---|---|---|");
    for (const item of data.missingInfoItems) {
      lines.push(`| #${item.number} | ${item.type} | ${item.title} | \`${item.suggestedAction}\` |`);
    }
    lines.push("");
  }

  lines.push("## Closure Candidates", "");
  if (data.closureCandidates.length === 0) {
    lines.push("_No immediate closure candidates._", "");
  } else {
    lines.push("| # | Type | Title | Reason |");
    lines.push("|---:|---|---|---|");
    for (const item of data.closureCandidates) {
      const reason = item.isConfirmedDuplicate
        ? "Confirmed Identity Duplicate [source]"
        : item.isSupersededCandidate
          ? "Superseded Candidate [source]"
          : `Suggested: ${item.suggestedAction} [advisory]`;
      lines.push(`| #${item.number} | ${item.type} | ${item.title} | ${reason} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate Markdown priority PR queue report.
 */
export function generatePriorityReport(items: MaintainerItem[], repo: string): string {
  const generatedAt = resolveGeneratedAt(items);
  const prs = sortItemsDeterministically(items.filter((i) => i.type === "pr"));

  const lines: string[] = [
    `# Maintainer Priority PR Queue: ${repo}`,
    "",
    `**Generated:** ${generatedAt} [source] | **Repository:** ${repo} [source]`,
    "",
    DISCLAIMER_BANNER,
    "",
    "## Active Pull Request Queue",
    "",
  ];

  if (prs.length === 0) {
    lines.push("_No pull requests in queue._", "");
    return lines.join("\n");
  }

  for (const pr of prs) {
    lines.push(`### PR #${pr.number}: ${pr.title}`);
    lines.push("");
    lines.push(`- **State:** ${pr.state} [source]`);
    lines.push(`- **Author:** @${pr.author} [source]`);
    lines.push(`- **Updated:** ${pr.updatedAt} [source]`);
    lines.push(`- **Urgency:** ${pr.urgency ? `${pr.urgency} [advisory]` : "unassigned"}`);
    lines.push(
      `- **Category:** ${pr.category ? `${pr.category} [advisory]` : "unassigned"}${pr.categoryConfidence ? ` (confidence: ${pr.categoryConfidence.toFixed(2)})` : ""}`,
    );
    lines.push(
      `- **Review Recommendation:** ${pr.reviewRecommendation ? `${pr.reviewRecommendation} [advisory]` : "none"}`,
    );
    lines.push(`- **Suggested Action:** \`${pr.suggestedAction}\` [advisory]`);

    if (pr.sourceBackedFacts.length > 0) {
      lines.push("- **Source-Backed Facts [source]:**");
      for (const fact of pr.sourceBackedFacts) {
        lines.push(`  - ${fact}`);
      }
    }

    if (pr.modelRecommendations.length > 0) {
      lines.push("- **Model Recommendations [advisory]:**");
      for (const rec of pr.modelRecommendations) {
        lines.push(`  - ${rec}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate Markdown duplicate/superseded report.
 */
export function generateDuplicatesReport(items: MaintainerItem[], repo: string): string {
  const generatedAt = resolveGeneratedAt(items);
  const confirmed = items.filter((i) => i.isConfirmedDuplicate);
  const fuzzy = items.filter((i) => i.isDuplicateCandidate && !i.isConfirmedDuplicate);
  const superseded = items.filter((i) => i.isSupersededCandidate);

  const lines: string[] = [
    `# Duplicate & Superseded Report: ${repo}`,
    "",
    `**Generated:** ${generatedAt} [source] | **Repository:** ${repo} [source]`,
    "",
    DISCLAIMER_BANNER,
    "",
    "## Confirmed Duplicates (Identity Matches)",
    "> [source] Grounded in identical commit hash, patch-id, or git tree.",
    "",
  ];

  if (confirmed.length === 0) {
    lines.push("_No confirmed duplicates identified._", "");
  } else {
    lines.push("| # | Type | Title | Cluster ID | Action |");
    lines.push("|---:|---|---|---:|---|");
    for (const item of confirmed) {
      lines.push(
        `| #${item.number} | ${item.type} | ${item.title} | ${item.clusterId ?? "-"} | \`${item.suggestedAction}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## Fuzzy Duplicate Candidates (Semantic Similarity)");
  lines.push(
    "> [advisory] NOTE: Candidate signal only — embedding similarity is NOT a confirmed duplicate. Maintainer manual review required.",
  );
  lines.push("");

  if (fuzzy.length === 0) {
    lines.push("_No fuzzy duplicate candidates identified._", "");
  } else {
    lines.push("| # | Type | Title | Cluster ID | Similarity | Action |");
    lines.push("|---:|---|---|---:|---:|---|");
    for (const item of fuzzy) {
      const simStr = item.clusterMinSimilarity !== null ? item.clusterMinSimilarity.toFixed(2) : "-";
      lines.push(
        `| #${item.number} | ${item.type} | ${item.title} | ${item.clusterId ?? "-"} | ${simStr} | \`${item.suggestedAction}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## Superseded Candidates");
  lines.push(
    "> [source] Open PRs whose corresponding issue tracker or related pull request is already closed or merged.",
  );
  lines.push("");

  if (superseded.length === 0) {
    lines.push("_No superseded candidates identified._", "");
  } else {
    lines.push("| # | Type | Title | Action |");
    lines.push("|---:|---|---|---|");
    for (const item of superseded) {
      lines.push(`| #${item.number} | ${item.type} | ${item.title} | \`${item.suggestedAction}\` |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate Markdown review progress report.
 */
export function generateProgressReport(items: MaintainerItem[], repo: string): string {
  const generatedAt = resolveGeneratedAt(items);

  const tiers = ["critical", "high", "medium", "low", "unassigned"];
  const byTier = tiers.map((tier) => {
    const tierItems = items.filter((i) => {
      if (tier === "unassigned") return !i.urgency;
      return i.urgency?.toLowerCase() === tier;
    });
    const reviewed = tierItems.filter((i) => i.hasDeepReview || i.reviewRecommendation !== null).length;
    return {
      tier,
      total: tierItems.length,
      reviewed,
      pending: tierItems.length - reviewed,
    };
  });

  const staleEvidence = items.filter((i) => i.jevDecisionAge === "stale" || i.deepReviewAge === "stale").length;
  const freshEvidence = items.filter(
    (i) => i.jevDecisionAge === "fresh" && (!i.hasDeepReview || i.deepReviewAge === "fresh"),
  ).length;
  const noEvidence = items.filter((i) => i.jevDecisionAge === "none" && !i.hasDeepReview).length;

  const lines: string[] = [
    `# Review Progress Report: ${repo}`,
    "",
    `**Generated:** ${generatedAt} [source] | **Repository:** ${repo} [source]`,
    "",
    DISCLAIMER_BANNER,
    "",
    "## Progress by Priority Tier",
    "",
    "| Tier | Total | Reviewed [source] | Pending | Coverage |",
    "|---|---:|---:|---:|---:|",
  ];

  for (const t of byTier) {
    const cov = t.total > 0 ? `${((t.reviewed / t.total) * 100).toFixed(1)}%` : "N/A";
    lines.push(`| ${t.tier} | ${t.total} | ${t.reviewed} | ${t.pending} | ${cov} |`);
  }

  lines.push("", "## Evidence Freshness", "");
  lines.push(`- **Fresh Evidence [source]:** ${freshEvidence}`);
  lines.push(`- **Stale Evidence [source]:** ${staleEvidence}`);
  lines.push(`- **No Evidence [source]:** ${noEvidence}`);
  lines.push("");

  return lines.join("\n");
}
