import { selectCanonical } from "../../canonical.js";
import { confidenceTier } from "../../confidence.js";
import { classifyClusterRelation } from "../../relations.js";
import { escapeTableCell } from "../../sanitize.js";
import { cosineSimilarity } from "../../similarity.js";
import type { VectorStore } from "../../store.js";
import type { Cluster, ScoredPR } from "../../types.js";

export interface GenerateMarkdownReportOptions {
  repoFull: string;
  date: string;
  stats: { totalItems: number; prs: number; issues: number };
  clusters: Cluster[];
  ranked: Array<Pick<ScoredPR, "number" | "score" | "author" | "title">>;
  visionResults: { aligned: number; drifting: number; offVision: number } | null;
  topN: number;
  clusterN: number;
  verbose: boolean;
  store: VectorStore;
}

/**
 * Read-only Markdown report renderer with storage dependencies.
 * Formats cluster statistics, overview metrics, canonical source selections,
 * and ranking tables into a GitHub Flavored Markdown document.
 *
 * NOTE: When `verbose` is true, this renderer queries `opts.store.getEmbedding()`
 * to compute pairwise cosine similarities against each cluster's canonical source
 * of truth. It does not perform any database mutations or network requests.
 */
export function generateMarkdownReport(opts: GenerateMarkdownReportOptions): string {
  const { repoFull, date, stats, clusters, ranked, visionResults, topN, clusterN, verbose, store } = opts;
  const dupeItemCount = clusters.reduce((s, c) => s + c.items.length, 0);

  let report = "# pr-prism triage report\n\n";
  report += `**repo:** ${repoFull}  \n`;
  report += `**date:** ${date}  \n`;
  report += `**items scanned:** ${stats.totalItems} (${stats.prs} PRs, ${stats.issues} issues)\n\n`;

  report += "## overview\n\n";
  report += "| metric | count |\n|--------|-------|\n";
  report += `| open PRs scanned | ${stats.prs} |\n`;
  report += `| open issues scanned | ${stats.issues} |\n`;
  report += `| duplicate clusters | ${clusters.length} |\n`;
  report += `| items in duplicate clusters | ${dupeItemCount} (${((dupeItemCount / stats.totalItems) * 100).toFixed(0)}% of total) |\n`;
  if (visionResults) {
    report += `| vision-aligned | ${visionResults.aligned} |\n`;
    report += `| vision-drifting | ${visionResults.drifting} |\n`;
    report += `| vision off-track | ${visionResults.offVision} |\n`;
  }
  report += "\n";

  report += `## duplicate clusters (top ${clusterN})\n\n`;
  report +=
    'these PRs/issues are similar enough to likely be duplicates. the "source of truth" is the highest-quality canonical item in each group.\n\n';
  report +=
    "**confidence** reflects the *minimum* pairwise similarity inside the cluster, not the average. clustering is single-linkage, so a cluster can chain in loosely-related items; a low min similarity means the members are not all mutually similar and the group should be eyeballed before closing anything. ";
  report += "high = min ≥ 90%, solid = min ≥ 80%, loose = min < 80% (likely chained, split before acting).\n\n";
  report += "| # | size | avg similarity | min similarity | confidence | source of truth | theme |\n";
  report += "|---|------|---------------|----------------|-----------|-----------------|-------|\n";
  for (const cluster of clusters.slice(0, clusterN)) {
    const theme = escapeTableCell(cluster.theme, 60);
    const minPct = cluster.minSimilarity * 100;
    const tier = confidenceTier(cluster.minSimilarity);
    const confidence = tier === "loose" ? "loose ⚠" : tier;
    const source = selectCanonical(cluster.items);
    const linkType = source.type === "pr" ? "pull" : "issues";
    report += `| ${cluster.id} | ${cluster.items.length} | ${(cluster.avgSimilarity * 100).toFixed(1)}% | ${minPct.toFixed(1)}% | ${confidence} | [#${source.number}](https://github.com/${repoFull}/${linkType}/${source.number}) | ${theme} |\n`;
  }
  report += "\n";

  if (verbose) {
    report += "## cluster details\n\n";
    report +=
      'each cluster expanded with per-item similarity against the source of truth. close duplicates as "duplicate of #source".\n\n';

    for (const cluster of clusters.slice(0, clusterN)) {
      const source = selectCanonical(cluster.items);

      const sourceId = `${repoFull}:${source.type}:${source.number}`;
      const sourceEmb = store.getEmbedding(sourceId);
      const sourceLinkType = source.type === "pr" ? "pull" : "issues";

      const themeText = escapeTableCell(cluster.theme, 80);
      report += `### cluster ${cluster.id}: ${themeText} (${cluster.items.length} items)\n\n`;
      report += `**source of truth:** [#${source.number}](https://github.com/${repoFull}/${sourceLinkType}/${source.number}) — "${escapeTableCell(source.title, 80)}"\n`;
      report += `opened: ${source.createdAt.slice(0, 10)} by @${source.author || "unknown"} | quality score: ${source.score.toFixed(2)}\n`;
      const rel = classifyClusterRelation(cluster.items);
      if (rel.relation !== undefined) {
        const edges = rel.closingEdges.map((e) => `#${e.pr} closes #${e.issue}`).join(", ");
        report += `relation: ${rel.relation}${edges ? ` (${edges})` : ""}\n`;
      }
      report += "\n";

      const dupes = cluster.items.filter((i) => i.number !== source.number);
      if (dupes.length > 0 && sourceEmb) {
        // Compute pairwise similarity vs source
        const dupesWithSim = dupes.map((item) => {
          const itemId = `${repoFull}:${item.type}:${item.number}`;
          const itemEmb = store.getEmbedding(itemId);
          let sim = 0;
          if (itemEmb && sourceEmb) {
            try {
              sim = cosineSimilarity(sourceEmb, itemEmb);
            } catch {
              sim = 0;
            }
          }
          return { ...item, similarity: sim };
        });

        // Sort by similarity descending
        dupesWithSim.sort((a, b) => b.similarity - a.similarity);

        report += `**duplicates (${dupes.length}):**\n\n`;
        report += "| # | similarity | title | opened | author |\n";
        report += "|---|-----------|-------|--------|--------|\n";
        for (const d of dupesWithSim) {
          const dLinkType = d.type === "pr" ? "pull" : "issues";
          const title = escapeTableCell(d.title, 60);
          report += `| [#${d.number}](https://github.com/${repoFull}/${dLinkType}/${d.number}) | ${(d.similarity * 100).toFixed(1)}% | ${title} | ${d.createdAt.slice(0, 10)} | @${d.author || "unknown"} |\n`;
        }
      } else if (dupes.length > 0) {
        report += `**duplicates (${dupes.length}):**\n\n`;
        report += "| # | title | opened | author |\n";
        report += "|---|-------|--------|--------|\n";
        for (const d of dupes) {
          const dLinkType = d.type === "pr" ? "pull" : "issues";
          const title = escapeTableCell(d.title, 60);
          report += `| [#${d.number}](https://github.com/${repoFull}/${dLinkType}/${d.number}) | ${title} | ${d.createdAt.slice(0, 10)} | @${d.author || "unknown"} |\n`;
        }
      }
      report += "\n---\n\n";
    }
  } else {
    // Non-verbose: show only large clusters in summary
    const bigClusters = clusters.filter((c) => c.items.length >= 10).slice(0, 10);
    if (bigClusters.length > 0) {
      report += "## largest duplicate groups\n\n";
      for (const cluster of bigClusters) {
        report += `### cluster #${cluster.id}: ${escapeTableCell(cluster.theme, 80)} (${cluster.items.length} items)\n\n`;
        report += "| # | author | title | updated |\n";
        report += "|---|--------|-------|--------|\n";
        for (const item of cluster.items.slice(0, 15)) {
          const title = escapeTableCell(item.title, 60);
          const linkType = item.type === "pr" ? "pull" : "issues";
          report += `| [#${item.number}](https://github.com/${repoFull}/${linkType}/${item.number}) | ${item.author || "?"} | ${title} | ${item.updatedAt.slice(0, 10)} |\n`;
        }
        if (cluster.items.length > 15) {
          report += `| ... | | +${cluster.items.length - 15} more | |\n`;
        }
        report += "\n";
      }
    }
  }

  report += `## top ${topN} ranked PRs\n\n`;
  report +=
    "ranked by quality signals: description quality, author track record, recency, CI status, review approvals.\n\n";
  report += "| rank | # | score | author | title |\n";
  report += "|------|---|-------|--------|-------|\n";
  for (let i = 0; i < Math.min(topN, ranked.length); i++) {
    const pr = ranked[i];
    const title = escapeTableCell(pr.title, 60);
    report += `| ${i + 1} | [#${pr.number}](https://github.com/${repoFull}/pull/${pr.number}) | ${pr.score.toFixed(2)} | ${pr.author || "?"} | ${title} |\n`;
  }
  report += "\n";

  if (visionResults) {
    report += "## vision alignment\n\n";
    report += "checked against the project's README for alignment with stated goals.\n\n";
    report += `- **aligned:** ${visionResults.aligned} items match the project vision\n`;
    report += `- **drifting:** ${visionResults.drifting} items are loosely related\n`;
    report += `- **off-vision:** ${visionResults.offVision} items don't match the project direction\n`;
    report += "\n";
  }

  report += "---\n*generated by [pr-prism](https://github.com/StressTestor/pr-prism)*\n";
  return report;
}
