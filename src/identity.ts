// Deterministic, non-embedding "confirmed duplicate" detection. Two PRs on the
// same head commit OID - or with an identical normalized diff - are the same
// change beyond doubt, independent of how the fuzzy embedding clusters group
// them. These surface as a separate "identity" tier above the similarity
// clusters. Cheap and exact: no model, no threshold.

import { createHash } from "node:crypto";
import { selectCanonical } from "./canonical.js";
import { scoreClusterItem } from "./cluster.js";
import type { VectorStore } from "./store.js";
import type { Cluster, PRItem } from "./types.js";

/**
 * git-patch-id-style fingerprint of a unified diff: drop the volatile
 * `index <sha>..<sha>` and `@@ ... @@` hunk-range lines (which shift when the
 * same change lands on a different base) and hash the rest. Not byte-identical
 * to `git patch-id`, but stable for "same change, different commits".
 */
export function diffFingerprint(diff: string): string {
  const normalized = diff
    .split("\n")
    .filter((line) => !line.startsWith("index ") && !line.startsWith("@@"))
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

function itemKey(pr: PRItem): string {
  return `${pr.repo}:${pr.number}`;
}

function pushGroup(map: Map<string, PRItem[]>, key: string, item: PRItem): void {
  const g = map.get(key);
  if (g) g.push(item);
  else map.set(key, [item]);
}

function makeIdentityCluster(members: PRItem[], identity: { basis: "head-oid" | "patch-id"; key: string }): Cluster {
  const items = members.map(scoreClusterItem).sort((a, b) => b.score - a.score);
  const bestPick = selectCanonical(items);
  return {
    id: 0, // reassigned by the caller
    items,
    bestPick,
    avgSimilarity: 1,
    minSimilarity: 1,
    theme: bestPick.title,
    kind: "identity",
    identity,
  };
}

/**
 * Find confirmed-duplicate PR groups. Pass 1 groups by head commit OID (strongest,
 * cheapest). Pass 2, over PRs not already claimed, groups by cached-diff
 * fingerprint when a store with cached diffs is supplied. Emits only groups of
 * size >= 2, in sorted-key order so output is deterministic.
 */
export function findConfirmedDuplicates(items: PRItem[], opts?: { store?: VectorStore }): Cluster[] {
  const prs = items.filter((i) => i.type === "pr");
  const groups: Cluster[] = [];
  const claimed = new Set<string>();

  // Pass 1: head commit OID.
  const byOid = new Map<string, PRItem[]>();
  for (const pr of prs) {
    if (pr.headRefOid) pushGroup(byOid, pr.headRefOid, pr);
  }
  for (const oid of [...byOid.keys()].sort()) {
    const members = byOid.get(oid) ?? [];
    if (members.length >= 2) {
      groups.push(makeIdentityCluster(members, { basis: "head-oid", key: oid }));
      for (const m of members) claimed.add(itemKey(m));
    }
  }

  // Pass 2: normalized-diff fingerprint over cached diffs (best-effort).
  if (opts?.store) {
    const byPatch = new Map<string, PRItem[]>();
    for (const pr of prs) {
      if (claimed.has(itemKey(pr))) continue;
      const diff = opts.store.getCachedDiff(pr.repo, pr.number);
      if (!diff) continue;
      pushGroup(byPatch, diffFingerprint(diff), pr);
    }
    for (const fp of [...byPatch.keys()].sort()) {
      const members = byPatch.get(fp) ?? [];
      if (members.length >= 2) {
        groups.push(makeIdentityCluster(members, { basis: "patch-id", key: fp }));
      }
    }
  }

  groups.forEach((g, i) => {
    g.id = i;
  });
  return groups;
}
