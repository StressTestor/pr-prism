/**
 * Task A — Candidate Relationship Discovery
 *
 * Indexed candidate-generation engine that discovers duplicate, cross-reference,
 * closing-reference, and supersession relationship candidates without all-pairs
 * quadratic comparisons or runtime LLM calls.
 */

import type { Cluster, PRItem } from "../types.js";

// Schema for this module
export const RELATIONSHIP_SCHEMA_VERSION = "1.0.0";

// Relationship types between two items
export type ItemRelationshipKind =
  | "DUPLICATE_CANDIDATE" // fuzzy embedding similarity + signal overlap
  | "SAME_UNDERLYING_PROBLEM" // same bug report, different PRs
  | "ALREADY_FIXED_CANDIDATE" // open issue + merged PR with closing reference
  | "SUPERSEDED_CANDIDATE" // newer open PR may supersede an older one
  | "CROSS_REFERENCE" // explicit GitHub cross-reference (mentioned in body)
  | "CLOSES_REFERENCE" // PR has closing keyword pointing to issue in cluster
  | "IDENTITY_DUPLICATE"; // same head-oid or patch-id (deterministic)

// Evidence tier — how confident we are WITHOUT Jev
export type EvidenceTier =
  | "DETERMINISTIC" // head-oid match, patch-id match
  | "STRONG" // merged PR + closing reference + matching files
  | "MODERATE" // embedding similarity >= 0.85 + label overlap
  | "WEAK" // embedding similarity >= 0.72 only
  | "INSUFFICIENT"; // below threshold

export interface RelationshipCandidate {
  sourceNumber: number;
  sourceType: "pr" | "issue";
  sourceRepo: string;
  targetNumber: number;
  targetType: "pr" | "issue";
  targetRepo: string;
  kind: ItemRelationshipKind;
  evidenceTier: EvidenceTier;
  evidenceFactors: string[]; // e.g. ["head_oid_match", "closes_reference", "embedding_sim:0.91"]
  embeddingSimilarity: number | null;
  closingEdge: boolean; // PR.closesIssues includes target
  labelOverlap: string[]; // shared label names
  sharedChangedFiles: string[]; // shared file paths if available
  sourceState: string; // open/closed/merged
  targetState: string;
  requiresJevValidation: boolean; // true when evidence is WEAK or MODERATE
  requiresHumanVerification: boolean; // always true — we never auto-close
  schemaVersion: string;
}

export interface RelationshipDiscoveryResult {
  schemaVersion: string;
  repo: string;
  generatedAt: string;
  candidateCount: number;
  candidates: RelationshipCandidate[];
  // Index stats
  indexedByEmbedding: number;
  indexedByClosingRef: number;
  indexedByHeadOid: number;
  indexedByCrossRef: number;
}

export interface RelationshipDiscoveryOptions {
  embeddingSimThreshold?: number; // default 0.72
  strongEvidenceThreshold?: number; // default 0.85
  repo?: string;
}

const TIER_ORDER: Record<EvidenceTier, number> = {
  INSUFFICIENT: 0,
  WEAK: 1,
  MODERATE: 2,
  STRONG: 3,
  DETERMINISTIC: 4,
};

function getLabelOverlap(a: PRItem, b: PRItem): string[] {
  if (!a.labels || !b.labels || a.labels.length === 0 || b.labels.length === 0) {
    return [];
  }
  const bSet = new Set(b.labels);
  const common = a.labels.filter((l) => bSet.has(l));
  return Array.from(new Set(common)).sort();
}

function determineEmbeddingTier(
  sim: number,
  hasLabelOverlap: boolean,
  strongThreshold: number,
  simThreshold: number,
): EvidenceTier {
  if (sim >= strongThreshold) {
    return hasLabelOverlap ? "STRONG" : "MODERATE";
  }
  if (sim >= simThreshold) {
    return hasLabelOverlap ? "MODERATE" : "WEAK";
  }
  return "INSUFFICIENT";
}

function canonicalKey(
  sourceRepo: string,
  sourceNumber: number,
  targetRepo: string,
  targetNumber: number,
  kind: ItemRelationshipKind,
): string {
  const minNum = Math.min(sourceNumber, targetNumber);
  const maxNum = Math.max(sourceNumber, targetNumber);
  const repo = sourceRepo || targetRepo;
  return `${repo}:${minNum}-${maxNum}-${kind}`;
}

/**
 * Main discovery function — indexed candidate generation without all-pairs LLM calls.
 */
export function discoverRelationshipCandidates(
  items: PRItem[],
  clusters: Cluster[],
  options?: RelationshipDiscoveryOptions,
): RelationshipDiscoveryResult {
  const defaultRepo = options?.repo || (items.length > 0 ? items[0].repo : "");
  const embeddingSimThreshold = options?.embeddingSimThreshold ?? 0.72;
  const strongEvidenceThreshold = options?.strongEvidenceThreshold ?? 0.85;

  const itemMap = new Map<string, PRItem>();
  for (const item of items) {
    itemMap.set(`${item.repo}#${item.number}`, item);
  }

  const candidatesMap = new Map<string, RelationshipCandidate>();

  function addCandidate(candidate: RelationshipCandidate): void {
    const key = canonicalKey(
      candidate.sourceRepo,
      candidate.sourceNumber,
      candidate.targetRepo,
      candidate.targetNumber,
      candidate.kind,
    );

    const existing = candidatesMap.get(key);
    if (!existing) {
      candidatesMap.set(key, candidate);
      return;
    }

    // Merge factors, labels, files, similarity
    const mergedFactors = Array.from(new Set([...existing.evidenceFactors, ...candidate.evidenceFactors]));
    const mergedLabels = Array.from(new Set([...existing.labelOverlap, ...candidate.labelOverlap]));
    const mergedFiles = Array.from(new Set([...existing.sharedChangedFiles, ...candidate.sharedChangedFiles]));

    if (TIER_ORDER[candidate.evidenceTier] > TIER_ORDER[existing.evidenceTier]) {
      existing.evidenceTier = candidate.evidenceTier;
    }

    existing.evidenceFactors = mergedFactors;
    existing.labelOverlap = mergedLabels;
    existing.sharedChangedFiles = mergedFiles;
    existing.closingEdge = existing.closingEdge || candidate.closingEdge;

    if (existing.embeddingSimilarity == null && candidate.embeddingSimilarity != null) {
      existing.embeddingSimilarity = candidate.embeddingSimilarity;
    } else if (existing.embeddingSimilarity != null && candidate.embeddingSimilarity != null) {
      existing.embeddingSimilarity = Math.max(existing.embeddingSimilarity, candidate.embeddingSimilarity);
    }

    existing.requiresJevValidation =
      existing.kind === "SUPERSEDED_CANDIDATE" ||
      existing.evidenceTier === "WEAK" ||
      existing.evidenceTier === "MODERATE";
  }

  // ── 1. Head-OID index ──────────────────────────────────────────────────────
  let indexedByHeadOid = 0;
  const headOidGroups = new Map<string, PRItem[]>();
  for (const item of items) {
    if (item.type === "pr" && item.headRefOid && item.headRefOid.trim() !== "") {
      indexedByHeadOid++;
      const groupKey = `${item.repo}:${item.headRefOid.trim()}`;
      const group = headOidGroups.get(groupKey);
      if (group) {
        group.push(item);
      } else {
        headOidGroups.set(groupKey, [item]);
      }
    }
  }

  const identityDuplicatePairs = new Set<string>();

  for (const group of headOidGroups.values()) {
    if (group.length >= 2) {
      const sortedGroup = [...group].sort((a, b) => a.number - b.number);
      for (let i = 0; i < sortedGroup.length; i++) {
        for (let j = i + 1; j < sortedGroup.length; j++) {
          const a = sortedGroup[i];
          const b = sortedGroup[j];
          const pairId = `${a.repo}:${Math.min(a.number, b.number)}-${Math.max(a.number, b.number)}`;
          identityDuplicatePairs.add(pairId);

          const labelOverlap = getLabelOverlap(a, b);
          const evidenceFactors = ["head_oid_match"];
          if (labelOverlap.length >= 2) {
            evidenceFactors.push("label_overlap");
          }

          addCandidate({
            sourceNumber: a.number,
            sourceType: a.type,
            sourceRepo: a.repo,
            targetNumber: b.number,
            targetType: b.type,
            targetRepo: b.repo,
            kind: "IDENTITY_DUPLICATE",
            evidenceTier: "DETERMINISTIC",
            evidenceFactors,
            embeddingSimilarity: null,
            closingEdge: false,
            labelOverlap,
            sharedChangedFiles: [],
            sourceState: a.state,
            targetState: b.state,
            requiresJevValidation: false,
            requiresHumanVerification: true,
            schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
          });
        }
      }
    }
  }

  // ── 2. Closing-reference index ─────────────────────────────────────────────
  let indexedByClosingRef = 0;
  const closingReferencePairs = new Set<string>();

  for (const item of items) {
    if (item.type === "pr" && Array.isArray(item.closesIssues) && item.closesIssues.length > 0) {
      indexedByClosingRef++;
      for (const closedNum of item.closesIssues) {
        // Enforce same-repo only (Rule 11: Cross-repo closing edges are NOT emitted)
        const target = itemMap.get(`${item.repo}#${closedNum}`);
        if (!target) continue;

        const pairId = `${item.repo}:${Math.min(item.number, target.number)}-${Math.max(item.number, target.number)}`;
        closingReferencePairs.add(pairId);

        const isMergedPR = item.state.toLowerCase() === "merged";
        const isOpenIssue = target.state.toLowerCase() === "open";
        const kind: ItemRelationshipKind = isMergedPR && isOpenIssue ? "ALREADY_FIXED_CANDIDATE" : "CLOSES_REFERENCE";

        const labelOverlap = getLabelOverlap(item, target);
        const evidenceFactors = ["closes_reference"];
        if (isMergedPR) {
          evidenceFactors.push("merged_pr");
        }
        if (labelOverlap.length >= 2) {
          evidenceFactors.push("label_overlap");
        }

        addCandidate({
          sourceNumber: item.number,
          sourceType: item.type,
          sourceRepo: item.repo,
          targetNumber: target.number,
          targetType: target.type,
          targetRepo: target.repo,
          kind,
          evidenceTier: "STRONG",
          evidenceFactors,
          embeddingSimilarity: null,
          closingEdge: true,
          labelOverlap,
          sharedChangedFiles: [],
          sourceState: item.state,
          targetState: target.state,
          requiresJevValidation: false,
          requiresHumanVerification: true,
          schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
        });
      }
    }
  }

  // ── 3. Cross-reference scan ────────────────────────────────────────────────
  let indexedByCrossRef = 0;
  const CROSS_REF_REGEX = /#(\d+)\b/g;

  for (const item of items) {
    if (!item.body) continue;
    const matches = item.body.matchAll(CROSS_REF_REGEX);
    const referencedNumbers = new Set<number>();
    for (const match of matches) {
      const num = Number.parseInt(match[1], 10);
      if (!Number.isNaN(num) && num !== item.number) {
        referencedNumbers.add(num);
      }
    }

    let hasInScopeRef = false;
    for (const refNum of referencedNumbers) {
      const target = itemMap.get(`${item.repo}#${refNum}`);
      if (!target) continue;

      hasInScopeRef = true;
      const pairId = `${item.repo}:${Math.min(item.number, target.number)}-${Math.max(item.number, target.number)}`;

      // If already a closing reference, enhance existing candidate instead of duplicate edge
      if (closingReferencePairs.has(pairId)) {
        const key = canonicalKey(item.repo, item.number, target.repo, target.number, "CLOSES_REFERENCE");
        const altKey = canonicalKey(item.repo, item.number, target.repo, target.number, "ALREADY_FIXED_CANDIDATE");
        const existing = candidatesMap.get(key) || candidatesMap.get(altKey);
        if (existing && !existing.evidenceFactors.includes("cross_reference")) {
          existing.evidenceFactors.push("cross_reference");
        }
        continue;
      }

      const labelOverlap = getLabelOverlap(item, target);
      const evidenceFactors = ["cross_reference"];
      if (labelOverlap.length >= 2) {
        evidenceFactors.push("label_overlap");
      }

      addCandidate({
        sourceNumber: item.number,
        sourceType: item.type,
        sourceRepo: item.repo,
        targetNumber: target.number,
        targetType: target.type,
        targetRepo: target.repo,
        kind: "CROSS_REFERENCE",
        evidenceTier: "MODERATE",
        evidenceFactors,
        embeddingSimilarity: null,
        closingEdge: Boolean(item.type === "pr" && item.closesIssues?.includes(target.number)),
        labelOverlap,
        sharedChangedFiles: [],
        sourceState: item.state,
        targetState: target.state,
        requiresJevValidation: true,
        requiresHumanVerification: true,
        schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
      });
    }

    if (hasInScopeRef) {
      indexedByCrossRef++;
    }
  }

  // ── 4. Cluster-based similarity & 6. Supersession heuristic ────────────────
  const uniqueClusterItemKeys = new Set<string>();
  for (const cluster of clusters) {
    if (!cluster.items) continue;
    for (const item of cluster.items) {
      uniqueClusterItemKeys.add(`${item.repo}#${item.number}`);
    }
  }
  const indexedByEmbedding = uniqueClusterItemKeys.size;

  for (const cluster of clusters) {
    const clusterItems = cluster.items;
    if (!clusterItems || clusterItems.length < 2) continue;

    const sim = cluster.avgSimilarity ?? cluster.minSimilarity ?? 1.0;
    if (sim < embeddingSimThreshold) continue;

    const simFactor = `embedding_sim:${sim.toFixed(2)}`;
    const allPRs = clusterItems.every((i) => i.type === "pr");
    const allIssues = clusterItems.every((i) => i.type === "issue");

    for (let i = 0; i < clusterItems.length; i++) {
      for (let j = i + 1; j < clusterItems.length; j++) {
        const a = clusterItems[i];
        const b = clusterItems[j];
        const pairId = `${a.repo}:${Math.min(a.number, b.number)}-${Math.max(a.number, b.number)}`;

        // Skip identity duplicates already handled deterministically
        if (identityDuplicatePairs.has(pairId)) {
          const idKey = canonicalKey(a.repo, a.number, b.repo, b.number, "IDENTITY_DUPLICATE");
          const existing = candidatesMap.get(idKey);
          if (existing) {
            existing.embeddingSimilarity = sim;
            if (!existing.evidenceFactors.includes(simFactor)) {
              existing.evidenceFactors.push(simFactor);
            }
          }
          continue;
        }

        // Skip closing references already handled in closing-ref index
        if (closingReferencePairs.has(pairId)) {
          const key = canonicalKey(a.repo, a.number, b.repo, b.number, "CLOSES_REFERENCE");
          const altKey = canonicalKey(a.repo, a.number, b.repo, b.number, "ALREADY_FIXED_CANDIDATE");
          const existing = candidatesMap.get(key) || candidatesMap.get(altKey);
          if (existing) {
            existing.embeddingSimilarity = sim;
            if (!existing.evidenceFactors.includes(simFactor)) {
              existing.evidenceFactors.push(simFactor);
            }
          }
          continue;
        }

        const labelOverlap = getLabelOverlap(a, b);
        const hasLabelOverlap = labelOverlap.length >= 2;
        const tier = determineEmbeddingTier(sim, hasLabelOverlap, strongEvidenceThreshold, embeddingSimThreshold);
        if (tier === "INSUFFICIENT") continue;

        const baseFactors = [simFactor];
        if (hasLabelOverlap) {
          baseFactors.push("label_overlap");
        }

        if (allPRs) {
          // Supersession heuristic within PRs: older PR + newer PR addressing same area -> SUPERSEDED_CANDIDATE if newer is open
          const timeA = Date.parse(a.createdAt);
          const timeB = Date.parse(b.createdAt);

          let newer: PRItem | null = null;
          let older: PRItem | null = null;
          if (!Number.isNaN(timeA) && !Number.isNaN(timeB)) {
            if (timeB > timeA) {
              newer = b;
              older = a;
            } else if (timeA > timeB) {
              newer = a;
              older = b;
            }
          }

          if (newer && older && newer.state.toLowerCase() === "open") {
            addCandidate({
              sourceNumber: newer.number,
              sourceType: newer.type,
              sourceRepo: newer.repo,
              targetNumber: older.number,
              targetType: older.type,
              targetRepo: older.repo,
              kind: "SUPERSEDED_CANDIDATE",
              evidenceTier: tier === "STRONG" ? "MODERATE" : tier,
              evidenceFactors: [...baseFactors, "newer_open_pr"],
              embeddingSimilarity: sim,
              closingEdge: false,
              labelOverlap,
              sharedChangedFiles: [],
              sourceState: newer.state,
              targetState: older.state,
              requiresJevValidation: true,
              requiresHumanVerification: true,
              schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
            });
          } else {
            const [first, second] = a.number < b.number ? [a, b] : [b, a];
            addCandidate({
              sourceNumber: first.number,
              sourceType: first.type,
              sourceRepo: first.repo,
              targetNumber: second.number,
              targetType: second.type,
              targetRepo: second.repo,
              kind: "DUPLICATE_CANDIDATE",
              evidenceTier: tier,
              evidenceFactors: baseFactors,
              embeddingSimilarity: sim,
              closingEdge: false,
              labelOverlap,
              sharedChangedFiles: [],
              sourceState: first.state,
              targetState: second.state,
              requiresJevValidation: tier === "WEAK" || tier === "MODERATE",
              requiresHumanVerification: true,
              schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
            });
          }
        } else if (allIssues) {
          const [first, second] = a.number < b.number ? [a, b] : [b, a];
          addCandidate({
            sourceNumber: first.number,
            sourceType: first.type,
            sourceRepo: first.repo,
            targetNumber: second.number,
            targetType: second.type,
            targetRepo: second.repo,
            kind: "DUPLICATE_CANDIDATE",
            evidenceTier: tier,
            evidenceFactors: baseFactors,
            embeddingSimilarity: sim,
            closingEdge: false,
            labelOverlap,
            sharedChangedFiles: [],
            sourceState: first.state,
            targetState: second.state,
            requiresJevValidation: tier === "WEAK" || tier === "MODERATE",
            requiresHumanVerification: true,
            schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
          });
        } else {
          // Mixed items in cluster -> SAME_UNDERLYING_PROBLEM
          const [first, second] = a.number < b.number ? [a, b] : [b, a];
          addCandidate({
            sourceNumber: first.number,
            sourceType: first.type,
            sourceRepo: first.repo,
            targetNumber: second.number,
            targetType: second.type,
            targetRepo: second.repo,
            kind: "SAME_UNDERLYING_PROBLEM",
            evidenceTier: tier,
            evidenceFactors: baseFactors,
            embeddingSimilarity: sim,
            closingEdge: false,
            labelOverlap,
            sharedChangedFiles: [],
            sourceState: first.state,
            targetState: second.state,
            requiresJevValidation: tier === "WEAK" || tier === "MODERATE",
            requiresHumanVerification: true,
            schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
          });
        }
      }
    }
  }

  const candidates = Array.from(candidatesMap.values());
  candidates.sort((a, b) => {
    const repoCmp = a.sourceRepo.localeCompare(b.sourceRepo);
    if (repoCmp !== 0) return repoCmp;
    const numCmp = a.sourceNumber - b.sourceNumber;
    if (numCmp !== 0) return numCmp;
    const targetCmp = a.targetNumber - b.targetNumber;
    if (targetCmp !== 0) return targetCmp;
    return a.kind.localeCompare(b.kind);
  });

  return {
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    repo: defaultRepo,
    generatedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    candidates,
    indexedByEmbedding,
    indexedByClosingRef,
    indexedByHeadOid,
    indexedByCrossRef,
  };
}
