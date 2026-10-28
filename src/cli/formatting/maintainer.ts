import chalk from "chalk";
import Table from "cli-table3";
import type { MaintainerItem } from "../../maintainer/types.js";
import { sanitizeTitle } from "../../sanitize.js";

export type { MaintainerItem };

export interface MaintainerItemFinding {
  severity: "critical" | "high" | "medium" | "low" | "info" | string;
  category?: string;
  fileOrSymbol?: string;
  description: string;
  groundedEvidence?: string;
}

export interface PaginationInfo {
  page: number;
  limit?: number;
  totalPages: number;
  totalItems: number;
}

export interface ShowItemData {
  number: number;
  type: "pr" | "issue";
  title: string;
  url: string;
  state: string;
  author: string;
  updatedAt: string;
  sourceFacts: Array<{ label: string; value: string | number; source: string }>;
  advisory: Array<{ label: string; value: string; source: string; confidence?: number }>;
  findings: MaintainerItemFinding[];
  suggestedAction: string;
}

export interface DuplicateClusterItem {
  number: number;
  title: string;
  author?: string;
  updatedAt?: string;
  score?: number;
  similarity?: number;
  isBest?: boolean;
}

export interface DuplicateClusterData {
  id: number | string;
  theme: string;
  kind: "identity" | "fuzzy";
  confidenceTier: "high" | "solid" | "loose" | "confirmed";
  minSimilarity?: number;
  avgSimilarity?: number;
  identityBasis?: "head-oid" | "patch-id";
  items: DuplicateClusterItem[];
}

export interface PrepareDraftData {
  action: string;
  number: number;
  type: "pr" | "issue";
  title: string;
  content: string;
  placeholders: Array<{ placeholder: string; description: string }>;
}

/**
 * Truncate a string to maxLen characters with ellipsis.
 */
function truncate(text: string, maxLen = 40): string {
  if (!text) return "";
  const sanitized = sanitizeTitle(text);
  if (sanitized.length <= maxLen) return sanitized;
  return `${sanitized.slice(0, maxLen - 3)}...`;
}

/**
 * Format urgency with specific colors and advisory suffix.
 */
function formatUrgency(urgency?: string | null): string {
  if (!urgency) return chalk.dim("unknown [advisory]");
  const u = urgency.toLowerCase();
  switch (u) {
    case "critical":
      return chalk.red("critical [advisory]");
    case "high":
      return chalk.yellow("high [advisory]");
    case "medium":
      return chalk.cyan("medium [advisory]");
    case "low":
      return chalk.dim("low [advisory]");
    default:
      return `${urgency} [advisory]`;
  }
}

/**
 * Format category with advisory label.
 */
function formatCategory(category?: string | null): string {
  if (!category) return chalk.dim("-");
  return `${category} [advisory]`;
}

/**
 * Format review status.
 */
function formatReviewStatus(review?: string | boolean | null): string {
  if (review === true || review === "reviewed" || review === "completed") {
    return chalk.green("reviewed");
  }
  if (review === false || review === "pending" || review === "queued") {
    return chalk.yellow("pending");
  }
  if (typeof review === "string" && review.trim().length > 0) {
    return review;
  }
  return chalk.dim("-");
}

/**
 * Format Worklist table in terminal format using cli-table3.
 */
export function formatWorklistTable(items: MaintainerItem[], pagination: PaginationInfo): string {
  const table = new Table({
    head: ["#", "Type", "Title", "Urgency", "Category", "Action", "State", "Review"].map((h) => chalk.bold(h)),
    colWidths: [8, 8, 42, 22, 22, 18, 10, 12],
    style: { head: [], border: [] },
  });

  for (const item of items) {
    const numStr = `#${item.number}`;
    const typeStr = item.type.toUpperCase();
    const titleStr = truncate(item.title, 40);
    const urgencyStr = formatUrgency(item.urgency);
    const categoryStr = formatCategory(item.category);
    const actionStr = item.suggestedAction ?? "-";
    const stateStr = item.state === "open" ? chalk.green(item.state) : chalk.dim(item.state);
    const reviewVal = item.hasDeepReview ? (item.reviewRecommendation ?? "reviewed") : "-";
    const reviewStr = formatReviewStatus(reviewVal);

    table.push([numStr, typeStr, titleStr, urgencyStr, categoryStr, actionStr, stateStr, reviewStr]);
  }

  const paginationStr = chalk.bold(
    `\nPage ${pagination.page} of ${pagination.totalPages} (${pagination.totalItems} items)`,
  );

  return `${table.toString()}\n${paginationStr}`;
}

/**
 * Format Worklist as Markdown table.
 */
export function formatWorklistMarkdown(items: MaintainerItem[], pagination: PaginationInfo): string {
  const lines: string[] = [];
  lines.push("| # | Type | Title | Urgency | Category | Action | State | Review |");
  lines.push("|---|------|-------|---------|----------|--------|-------|--------|");

  for (const item of items) {
    const num = `#${item.number}`;
    const type = item.type;
    const title = sanitizeTitle(item.title).replace(/\|/g, "\\|");
    const urgency = item.urgency ? `${item.urgency} [advisory]` : "-";
    const category = item.category ? `${item.category} [advisory]` : "-";
    const action = item.suggestedAction ?? "-";
    const state = item.state;
    const review = item.hasDeepReview ? (item.reviewRecommendation ?? "reviewed") : "-";

    lines.push(`| ${num} | ${type} | ${title} | ${urgency} | ${category} | ${action} | ${state} | ${review} |`);
  }

  lines.push("");
  lines.push(`*Page ${pagination.page} of ${pagination.totalPages} (${pagination.totalItems} items)*`);
  return lines.join("\n");
}

/**
 * Format a single finding in terminal or markdown.
 */
export function formatFindingLine(finding: MaintainerItemFinding): string {
  const sevColor =
    finding.severity === "critical"
      ? chalk.red.bold
      : finding.severity === "high"
        ? chalk.yellow.bold
        : finding.severity === "medium"
          ? chalk.cyan
          : chalk.dim;

  const loc = finding.fileOrSymbol ? ` in ${finding.fileOrSymbol}` : "";
  const cat = finding.category ? ` ${finding.category}` : "";
  let out = `${sevColor(`[${finding.severity}]`)}${cat}${loc}: ${finding.description}`;
  if (finding.groundedEvidence) {
    out += `\n  ${chalk.dim("Evidence:")} "${chalk.italic(finding.groundedEvidence)}" ${chalk.dim("(model-cited)")}`;
  }
  return out;
}

/**
 * Display `show` output in terminal format.
 */
export function displayShowTerminal(data: ShowItemData): void {
  const typeUpper = data.type.toUpperCase();
  console.log(chalk.bold(`\n=== ${typeUpper} #${data.number}: ${sanitizeTitle(data.title)} ===`));
  console.log(`URL: ${chalk.underline(data.url)}`);
  console.log(`State: ${data.state} | Author: ${data.author} | Updated: ${data.updatedAt}\n`);

  console.log(chalk.bold("── Source-Backed Facts ──────────────────────"));
  if (data.sourceFacts.length === 0) {
    console.log(chalk.dim("• none recorded"));
  } else {
    for (const fact of data.sourceFacts) {
      console.log(`• ${fact.label}: ${fact.value} ${chalk.dim(`(${fact.source})`)}`);
    }
  }

  console.log(chalk.bold("\n── Advisory (Model Recommendations) ─────────"));
  if (data.advisory.length === 0) {
    console.log(chalk.dim("• none recorded"));
  } else {
    for (const adv of data.advisory) {
      const confStr = adv.confidence !== undefined ? `, confidence ${(adv.confidence * 100).toFixed(0)}%` : "";
      console.log(`• ${adv.label}: ${adv.value} ${chalk.dim(`[${adv.source}${confStr}]`)} ${chalk.dim("[advisory]")}`);
    }
  }

  console.log(chalk.bold("\n── Model Findings ─────────────────────────"));
  console.log(chalk.dim("NOTE: The following are model suggestions, not independently verified defects."));
  if (data.findings.length === 0) {
    console.log(chalk.dim("None recorded."));
  } else {
    for (const finding of data.findings) {
      console.log(formatFindingLine(finding));
    }
  }

  console.log(chalk.bold("\n── Suggested Action ──────────────────────"));
  console.log(chalk.green.bold(`→ ${data.suggestedAction}\n`));
}

/**
 * Format `show` output as Markdown.
 */
export function formatShowMarkdown(data: ShowItemData): string {
  const lines: string[] = [];
  lines.push(`# ${data.type.toUpperCase()} #${data.number}: ${sanitizeTitle(data.title)}`);
  lines.push(`**URL:** ${data.url}`);
  lines.push(`**State:** ${data.state} | **Author:** ${data.author} | **Updated:** ${data.updatedAt}`);
  lines.push("");

  lines.push("## Source-Backed Facts");
  if (data.sourceFacts.length === 0) {
    lines.push("- None recorded");
  } else {
    for (const fact of data.sourceFacts) {
      lines.push(`- **${fact.label}:** ${fact.value} *(${fact.source})*`);
    }
  }
  lines.push("");

  lines.push("## Advisory (Model Recommendations)");
  if (data.advisory.length === 0) {
    lines.push("- None recorded");
  } else {
    for (const adv of data.advisory) {
      const confStr = adv.confidence !== undefined ? `, confidence ${(adv.confidence * 100).toFixed(0)}%` : "";
      lines.push(`- **${adv.label}:** ${adv.value} *[${adv.source}${confStr}] [advisory]*`);
    }
  }
  lines.push("");

  lines.push("## Model Findings");
  lines.push("> NOTE: The following are model suggestions, not independently verified defects.");
  lines.push("");
  if (data.findings.length === 0) {
    lines.push("None recorded.");
  } else {
    for (const finding of data.findings) {
      const loc = finding.fileOrSymbol ? ` in \`${finding.fileOrSymbol}\`` : "";
      const cat = finding.category ? ` ${finding.category}` : "";
      lines.push(`- **[${finding.severity}]**${cat}${loc}: ${finding.description}`);
      if (finding.groundedEvidence) {
        lines.push(`  - *Evidence:* \`${finding.groundedEvidence}\` *(model-cited)*`);
      }
    }
  }
  lines.push("");

  lines.push("## Suggested Action");
  lines.push(`→ **${data.suggestedAction}**`);
  return lines.join("\n");
}

/**
 * Display `duplicates` output in terminal format.
 */
export function displayDuplicatesTerminal(clusters: DuplicateClusterData[]): void {
  if (clusters.length === 0) {
    console.log(chalk.yellow("No duplicate clusters found."));
    return;
  }

  console.log(chalk.bold(`\nFound ${clusters.length} duplicate cluster(s):\n`));

  for (const cluster of clusters) {
    const isIdentity = cluster.kind === "identity";
    const headerPrefix = isIdentity
      ? chalk.green.bold(`★ Confirmed Duplicate (${cluster.identityBasis || "identity"})`)
      : chalk.bold(`Cluster #${cluster.id}: "${sanitizeTitle(cluster.theme)}"`);

    const tierBadge = isIdentity
      ? chalk.green("[Tier: confirmed]")
      : cluster.confidenceTier === "high"
        ? chalk.green(`[Tier: high]`)
        : cluster.confidenceTier === "solid"
          ? chalk.yellow(`[Tier: solid]`)
          : chalk.dim(`[Tier: loose]`);

    console.log(`${headerPrefix} ${tierBadge}`);

    if (!isIdentity) {
      console.log(chalk.yellow("  ⚠ fuzzy — verify before closing"));
      if (cluster.avgSimilarity !== undefined) {
        console.log(
          chalk.dim(
            `  Avg similarity: ${(cluster.avgSimilarity * 100).toFixed(1)}%${
              cluster.minSimilarity !== undefined
                ? ` | Min similarity: ${(cluster.minSimilarity * 100).toFixed(1)}%`
                : ""
            }`,
          ),
        );
      }
    }

    for (const item of cluster.items) {
      const star = item.isBest ? chalk.green("  ★") : "   ";
      const scoreStr = item.score !== undefined ? ` | Score: ${item.score.toFixed(2)}` : "";
      const simStr = item.similarity !== undefined ? ` | Sim: ${(item.similarity * 100).toFixed(0)}%` : "";
      const authorStr = item.author ? ` | Author: ${item.author}` : "";
      console.log(`${star} #${item.number} ${sanitizeTitle(item.title)}${authorStr}${simStr}${scoreStr}`);
    }
    console.log();
  }
}

/**
 * Format `duplicates` as Markdown.
 */
export function formatDuplicatesMarkdown(clusters: DuplicateClusterData[]): string {
  const lines: string[] = [];
  lines.push(`# Duplicate Detection Report`);
  lines.push(`Found ${clusters.length} duplicate cluster(s).\n`);

  for (const cluster of clusters) {
    const isIdentity = cluster.kind === "identity";
    if (isIdentity) {
      lines.push(`### ★ Confirmed Duplicate (${cluster.identityBasis || "identity"})`);
    } else {
      lines.push(`### Cluster #${cluster.id}: ${sanitizeTitle(cluster.theme)}`);
      lines.push(`*Tier: ${cluster.confidenceTier} | ⚠ fuzzy — verify before closing*`);
      if (cluster.avgSimilarity !== undefined) {
        lines.push(`*Avg Similarity: ${(cluster.avgSimilarity * 100).toFixed(1)}%*`);
      }
    }
    lines.push("");

    for (const item of cluster.items) {
      const star = item.isBest ? "★ " : "- ";
      const authorStr = item.author ? ` (Author: ${item.author})` : "";
      lines.push(`${star}#${item.number} ${sanitizeTitle(item.title)}${authorStr}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Display `prepare` draft in terminal format.
 */
export function displayPrepareTerminal(draft: PrepareDraftData): void {
  console.log(chalk.bold.yellow("\nDRAFT: Edit before submitting"));
  console.log(chalk.dim("─".repeat(60)));
  console.log(draft.content);
  console.log(chalk.dim("─".repeat(60)));

  console.log(chalk.bold("\n── Editable Placeholders ───────────────────"));
  if (draft.placeholders.length === 0) {
    console.log(chalk.dim("No placeholders required."));
  } else {
    for (const p of draft.placeholders) {
      console.log(`• ${chalk.cyan(p.placeholder)} : ${p.description}`);
    }
  }
  console.log();
}

/**
 * Format `prepare` draft as Markdown.
 */
export function formatPrepareMarkdown(draft: PrepareDraftData): string {
  const lines: string[] = [];
  lines.push("<!-- DRAFT: Edit before submitting -->");
  lines.push(draft.content);
  lines.push("");
  lines.push("<!--");
  lines.push("Editable Placeholders:");
  for (const p of draft.placeholders) {
    lines.push(`- ${p.placeholder}: ${p.description}`);
  }
  lines.push("-->");
  return lines.join("\n");
}
