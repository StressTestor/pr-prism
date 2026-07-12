// The housekeeping manifest: the pitch headline. Turns clusters into an EDITABLE
// markdown to-do a maintainer works through by hand - tracker (original bug) +
// role-tagged fix/duplicate candidates + paste-ready "duplicate of #N" close text,
// with loose/confirmed tiers surfaced. pr-prism never writes to the repo; this is
// a document you edit and act on (respects the read-only ethos + the write-gate).

import { selectTracker } from "./canonical.js";
import { confidenceTier } from "./confidence.js";
import { sanitizeTitle } from "./sanitize.js";
import type { Cluster, ScoredPR } from "./types.js";

function itemRef(item: ScoredPR): string {
  // Each item carries its own repo - critical for cross-repo clusters, where a
  // manifest-level repo would build the wrong URL.
  const path = item.type === "pr" ? "pull" : "issues";
  return `[#${item.number}](https://github.com/${item.repo}/${path}/${item.number})`;
}

function clusterSection(c: Cluster): string {
  const tier = confidenceTier(c.minSimilarity);
  const confirmed = c.kind === "identity";
  const lines: string[] = [];

  const badge = confirmed ? "confirmed" : tier === "loose" ? "loose ⚠ review" : tier;
  lines.push(`### ${sanitizeTitle(c.theme, 80)}  _(${badge})_`);

  // Confirmed clusters are exact-duplicate PRs: no tracker issue is needed - keep
  // the canonical (merged-preferred bestPick) and close the rest against it.
  if (confirmed) {
    const canonical = c.bestPick;
    const basis = c.identity?.basis === "patch-id" ? "identical diff" : "same head commit";
    lines.push(
      `> confirmed duplicate (${basis}) — keep ${itemRef(canonical)}, close the rest as \`duplicate of #${canonical.number}\`:`,
    );
    for (const item of c.items.filter((i) => i.number !== canonical.number)) {
      lines.push(`- [ ] ${itemRef(item)} ${sanitizeTitle(item.title, 80)}`);
    }
    return lines.join("\n");
  }

  const { tracker, needsTracker, candidates } = selectTracker(c.items);
  if (needsTracker) {
    lines.push("no tracker issue filed. consider opening one, then close these against it:");
    for (const { item } of candidates) {
      lines.push(`- [ ] ${itemRef(item)} ${sanitizeTitle(item.title, 80)}`);
    }
  } else if (tracker) {
    lines.push(`tracker (original bug): ${itemRef(tracker)} — "${sanitizeTitle(tracker.title, 80)}"`);
    if (tier === "loose") {
      lines.push("⚠ loose cluster — verify these are the same bug before closing:");
    } else {
      lines.push(`close as \`duplicate of #${tracker.number}\`:`);
    }
    for (const { item, role } of candidates) {
      lines.push(`- [ ] ${itemRef(item)} (${role}) ${sanitizeTitle(item.title, 80)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the editable housekeeping manifest. Confirmed (identity) clusters lead,
 * then the fuzzy clusters. Pure: clusters in, markdown out, no side effects.
 */
export function buildHousekeepingManifest(clusters: Cluster[], opts: { repo: string; confirmed?: Cluster[] }): string {
  const all = [...(opts.confirmed ?? []), ...clusters];
  const confirmedCount = all.filter((c) => c.kind === "identity").length;
  const looseCount = all.filter((c) => confidenceTier(c.minSimilarity) === "loose").length;

  const header = [
    `# pr-prism housekeeping — ${opts.repo}`,
    "",
    `${all.length} clusters (${confirmedCount} confirmed, ${looseCount} loose/review). this is an editable manifest — pr-prism never writes to your repo. check items off as you close them and copy the \`duplicate of #N\` text into GitHub.`,
    "",
  ].join("\n");

  const sections = all.map((c) => clusterSection(c)).join("\n\n");
  return `${header}\n${sections}\n`;
}
