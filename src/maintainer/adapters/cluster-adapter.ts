/**
 * Maintainer Workbench — Cluster Adapter
 *
 * Ingests duplicate clusters (both fuzzy embeddings and deterministic identity
 * clusters) and maps item numbers to their cluster membership metadata.
 */

import { confidenceTier } from "../../confidence.js";
import type { Cluster } from "../../types.js";

/**
 * Membership details of a PR or issue within a duplicate cluster.
 */
export interface ClusterMembership {
  /** Numerical ID of the cluster. */
  clusterId: number;
  /** Total number of member items in the cluster. */
  clusterSize: number;
  /** Whether the cluster is a deterministic confirmed-duplicate identity group. */
  isConfirmedDuplicate: boolean;
  /** Minimum pairwise similarity across all members in the cluster. */
  minSimilarity: number;
  /** Categorical tightness confidence tier ("high", "solid", or "loose"). */
  confidence: "high" | "solid" | "loose";
  /** Whether this specific member is the designated canonical best pick. */
  isBestPick: boolean;
  /** Descriptive theme or title representing the cluster. */
  theme: string;
}

/**
 * Builds an index of cluster memberships keyed by item number.
 *
 * @param clusters Array of clusters produced by clustering or identity detection
 * @returns Map from item number to ClusterMembership
 */
export function buildClusterMembershipMap(clusters: Cluster[]): Map<number, ClusterMembership> {
  const map = new Map<number, ClusterMembership>();

  for (const cluster of clusters) {
    const isConfirmed = cluster.kind === "identity" || Boolean(cluster.identity);
    const confidence = confidenceTier(cluster.minSimilarity);

    for (const member of cluster.items) {
      const isBestPick =
        cluster.bestPick.number === member.number && (member.type ? cluster.bestPick.type === member.type : true);

      map.set(member.number, {
        clusterId: cluster.id,
        clusterSize: cluster.items.length,
        isConfirmedDuplicate: isConfirmed,
        minSimilarity: cluster.minSimilarity,
        confidence,
        isBestPick,
        theme: cluster.theme,
      });
    }
  }

  return map;
}
