/**
 * Maintainer Workbench — Worklist Builder
 *
 * Core coordinator assembling unified MaintainerItem views from VectorStore,
 * JevDecisionStore, duplicate clusters, and deep reviews. Provides deterministic
 * multi-dimensional filtering, sorting, and pagination.
 */

import type { JevDecisionStore } from "../decisions/decision-store.js";
import type { JevFirstDecisionRecord } from "../decisions/triage-v2.js";
import type { DurableReviewQueue } from "../review-queue.js";
import { scorePR } from "../scorer.js";
import type { VectorStore } from "../store.js";
import type { Cluster, PRItem, ScoredPR } from "../types.js";
import { buildClusterMembershipMap, type ClusterMembership } from "./adapters/cluster-adapter.js";
import { buildDecisionMap, computeDecisionFreshness } from "./adapters/decision-adapter.js";
import { computeReviewFreshness, getReviewResult } from "./adapters/review-adapter.js";
import { getStoreItems } from "./adapters/store-adapter.js";
import type {
  MaintainerAdapterPort,
  MaintainerItem,
  SuggestedAction,
  WorklistFilter,
  WorklistPage,
  WorklistSort,
} from "./types.js";

/**
 * Options supplied to build the maintainer worklist.
 */
export interface WorklistBuildOptions {
  /** SQLite VectorStore containing indexed PRs and issues. */
  store: VectorStore;
  /** Full repository name (e.g. "owner/repo"). */
  repo: string;
  /** Duplicate clusters discovered by clustering or identity detection. */
  clusters: Cluster[];
  /** Optional JevDecisionStore for Stage A typed decisions. */
  jevStore?: JevDecisionStore;
  /** Optional DurableReviewQueue for v4 multi-account review checkpoints. */
  queue?: DurableReviewQueue;
  /** Optional filter criteria. */
  filter?: WorklistFilter;
  /** Optional sort options. */
  sort?: WorklistSort;
  /** Optional pagination parameters. */
  page?: WorklistPage;
}

/**
 * Result returned by buildWorklist.
 */
export interface WorklistResult {
  /** Array of maintainer items in current page. */
  items: MaintainerItem[];
  /** Total count of items in repository before filtering. */
  total: number;
  /** Total count of items matching filter criteria. */
  filtered: number;
  /** Pagination metadata. */
  page: { offset: number; limit: number; hasMore: boolean };
}

interface BuildItemInternalOptions {
  item: PRItem;
  membership?: ClusterMembership;
  decision?: JevFirstDecisionRecord;
  rawReview?: { reviewedAt: string } | undefined;
  reviewResult: ReturnType<typeof getReviewResult>;
  scoredPR?: ScoredPR;
  storeItemsMap: Map<string, PRItem>;
  clusters: Cluster[];
}

/**
 * Internal helper to test if an open PR is superseded by a closed tracker or merged sibling.
 */
function checkIsSuperseded(
  item: PRItem,
  membership: ClusterMembership | undefined,
  clusters: Cluster[],
  storeItemsMap: Map<string, PRItem>,
): boolean {
  if (item.type !== "pr" || item.state !== "open") {
    return false;
  }

  // 1. Check closing keywords / linked issues
  if (Array.isArray(item.closesIssues) && item.closesIssues.length > 0) {
    for (const issueNum of item.closesIssues) {
      const issue = storeItemsMap.get(`issue:${issueNum}`) ?? storeItemsMap.get(String(issueNum));
      if (issue && (issue.state === "closed" || issue.state === "merged")) {
        return true;
      }
    }
  }

  // 2. Check cluster membership: tracker issue closed or another PR merged
  if (membership) {
    const cluster = clusters.find((c) => c.id === membership.clusterId);
    if (cluster) {
      // Sibling PR in cluster is already merged
      const hasMergedSibling = cluster.items.some(
        (m) => m.number !== item.number && m.type === "pr" && m.state === "merged",
      );
      if (hasMergedSibling) {
        return true;
      }

      // Earliest issue in cluster (tracker) is closed/merged
      const issueMembers = cluster.items.filter((m) => m.type === "issue");
      if (issueMembers.length > 0) {
        const tracker = issueMembers.reduce((earliest, cur) =>
          new Date(cur.createdAt).getTime() < new Date(earliest.createdAt).getTime() ? cur : earliest,
        );
        const trackerItem = storeItemsMap.get(`issue:${tracker.number}`) ?? tracker;
        if (trackerItem.state === "closed" || trackerItem.state === "merged") {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Builds a single canonical MaintainerItem from component facts.
 */
function buildMaintainerItem(opts: BuildItemInternalOptions): MaintainerItem {
  const { item, membership, decision, rawReview, reviewResult, scoredPR, storeItemsMap, clusters } = opts;

  // Jev facts
  const hasJevDecision = Boolean(decision);
  const jevDecisionAge = computeDecisionFreshness(decision, item);

  const category = decision?.classification.category ?? null;
  const categoryConfidence = decision?.classification.categoryConfidence ?? null;
  const urgency = decision?.derived.priorityTier ?? null;
  const technicalDomain = decision?.classification.technicalDomain ?? null;
  const advisoryRoute = decision?.routing.advisoryRoute ?? null;
  const escalateToDeepReview = decision?.routing.escalateToDeepReview ?? null;
  const evidenceQuality = decision?.scores.reproductionEvidenceNorm ?? null;

  const securityRisk = decision
    ? Boolean(
        decision.derived.riskFlags.includes("security") ||
          (decision.scores.securityVulnerabilityProb !== null && decision.scores.securityVulnerabilityProb >= 0.5) ||
          decision.routing.deterministicSafetyGates.some((g) => g.startsWith("safety_gate:security")),
      )
    : null;

  const breakingChangeRisk = decision
    ? Boolean(
        decision.derived.riskFlags.includes("breaking_change") ||
          (decision.scores.breakingChangeProb !== null && decision.scores.breakingChangeProb >= 0.55) ||
          decision.routing.deterministicSafetyGates.some((g) => g.startsWith("safety_gate:breaking")),
      )
    : null;

  const dataLossRisk = decision
    ? Boolean(
        decision.derived.riskFlags.includes("data_loss") ||
          (decision.scores.dataLossOrCorruptionProb !== null && decision.scores.dataLossOrCorruptionProb >= 0.5) ||
          decision.routing.deterministicSafetyGates.some((g) => g.startsWith("safety_gate:data_loss")),
      )
    : null;

  const missingInformation = decision
    ? Boolean(
        (decision.scores.missingInformationProb !== null && decision.scores.missingInformationProb >= 0.5) ||
          decision.routing.uncertaintyFlags.some((u) => u.includes("missing") || u.includes("empty")),
      )
    : null;

  // Cluster facts
  const clusterId = membership ? membership.clusterId : null;
  const clusterSize = membership ? membership.clusterSize : 0;
  const isDuplicateCandidate = membership ? membership.clusterSize > 1 && !membership.isBestPick : false;
  const isConfirmedDuplicate = membership ? membership.isConfirmedDuplicate && !membership.isBestPick : false;
  const isSupersededCandidate = checkIsSuperseded(item, membership, clusters, storeItemsMap);
  const clusterMinSimilarity = membership ? membership.minSimilarity : null;
  const clusterConfidence = membership ? membership.confidence : null;

  // Review facts
  const hasDeepReview = reviewResult.hasReview;
  const deepReviewAge = computeReviewFreshness(rawReview?.reviewedAt, item.updatedAt);
  const reviewRecommendation = reviewResult.recommendation;
  const reviewConfidence = reviewResult.confidence;

  // Quality score
  let qualityScore: number | null = null;
  if (scoredPR && typeof scoredPR.score === "number") {
    qualityScore = scoredPR.score;
  } else if (typeof (item as any).score === "number") {
    qualityScore = (item as any).score;
  } else if (item.type === "pr") {
    try {
      const defaultScoringConfig = {
        scoring: {
          weights: {
            has_tests: 0.25,
            ci_passing: 0.2,
            diff_size_penalty: 0.15,
            author_history: 0.15,
            description_quality: 0.15,
            review_approvals: 0.1,
          },
        },
      } as any;
      const scored = scorePR(item, defaultScoringConfig, { authorMergeCounts: new Map() });
      qualityScore = scored.score;
    } catch {
      qualityScore = null;
    }
  }

  // Derive suggestedAction per spec priority
  let suggestedAction: SuggestedAction = "monitor";
  if (isConfirmedDuplicate) {
    suggestedAction = "close_duplicate";
  } else if (isSupersededCandidate) {
    suggestedAction = "close_superseded";
  } else if (missingInformation) {
    suggestedAction = "request_info";
  } else if (reviewRecommendation === "revise") {
    suggestedAction = "request_changes";
  } else if (escalateToDeepReview && !hasDeepReview) {
    suggestedAction = "needs_deep_review";
  } else if (reviewRecommendation === "merge") {
    suggestedAction = "ready_to_merge";
  } else {
    suggestedAction = "monitor";
  }

  // Derive readyForAction: item is open and has an actionable path
  const readyForAction = item.state === "open" && suggestedAction !== "monitor";

  // Grounded data facts
  const sourceBackedFacts: string[] = [
    `state: ${item.state} (GitHub API)`,
    `author: ${item.author} (GitHub API)`,
    `created: ${item.createdAt} (GitHub API)`,
    `updated: ${item.updatedAt} (GitHub API)`,
  ];
  if (qualityScore !== null) {
    sourceBackedFacts.push(`quality score: ${qualityScore.toFixed(2)} (scorer.ts)`);
  }
  if (item.ciStatus) {
    sourceBackedFacts.push(`ci: ${item.ciStatus} (GitHub Actions)`);
  }
  if (item.hasTests !== undefined) {
    sourceBackedFacts.push(`tests: ${String(item.hasTests)} (diff analysis)`);
  }
  if (membership) {
    sourceBackedFacts.push(
      `cluster #${membership.clusterId} (${membership.clusterSize} items, ${(membership.minSimilarity * 100).toFixed(0)}% min similarity)`,
    );
    if (isConfirmedDuplicate) {
      sourceBackedFacts.push("confirmed duplicate: head-oid match");
    } else if (membership.isBestPick) {
      sourceBackedFacts.push("cluster role: canonical best pick");
    }
  }
  if (isSupersededCandidate) {
    sourceBackedFacts.push("superseded candidate: tracker issue or sibling PR is closed/merged");
  }
  if (hasDeepReview) {
    sourceBackedFacts.push(
      `deep review recommendation: ${reviewRecommendation} (confidence: ${(reviewConfidence ?? 0).toFixed(2)})`,
    );
  }

  // Advisory model recommendations
  const modelRecommendations: string[] = [];
  if (decision) {
    if (category) {
      modelRecommendations.push(
        `category: ${category} (Jev, confidence ${categoryConfidence !== null ? categoryConfidence.toFixed(2) : "n/a"})`,
      );
    }
    if (urgency) {
      modelRecommendations.push(`urgency: ${urgency} (Jev)`);
    }
    if (technicalDomain) {
      modelRecommendations.push(`technical domain: ${technicalDomain} (Jev)`);
    }
    if (advisoryRoute) {
      modelRecommendations.push(`advisory route: ${advisoryRoute} (Jev)`);
    }
    if (escalateToDeepReview) {
      modelRecommendations.push("escalate to deep review: true (Jev)");
    }
    if (securityRisk) {
      modelRecommendations.push("security risk advisory (Jev)");
    }
    if (breakingChangeRisk) {
      modelRecommendations.push("breaking change risk advisory (Jev)");
    }
    if (dataLossRisk) {
      modelRecommendations.push("data loss risk advisory (Jev)");
    }
    if (missingInformation) {
      modelRecommendations.push("missing information advisory (Jev)");
    }
  }
  if (hasDeepReview && reviewResult.summary) {
    modelRecommendations.push(`deep review summary: ${reviewResult.summary}`);
  }

  const normalizedState = item.state === "closed" || item.state === "merged" ? item.state : "open";

  return {
    repo: item.repo,
    number: item.number,
    type: item.type,
    url: `https://github.com/${item.repo}/${item.type === "pr" ? "pull" : "issues"}/${item.number}`,
    title: item.title,
    state: normalizedState,
    author: item.author || "unknown",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    labels: Array.isArray(item.labels) ? item.labels : [],
    incidentClosed: item.incidentClosed === true ? true : undefined,

    category,
    categoryConfidence,
    urgency,
    technicalDomain,
    advisoryRoute,
    escalateToDeepReview,
    evidenceQuality,
    securityRisk,
    breakingChangeRisk,
    dataLossRisk,
    missingInformation,
    hasJevDecision,
    jevDecisionAge,

    clusterId,
    clusterSize,
    isDuplicateCandidate,
    isConfirmedDuplicate,
    isSupersededCandidate,
    clusterMinSimilarity,
    clusterConfidence,

    hasDeepReview,
    deepReviewAge,
    reviewRecommendation,
    reviewConfidence,

    qualityScore,

    suggestedAction,
    readyForAction,
    sourceBackedFacts,
    modelRecommendations,
  };
}

/**
 * Filters maintainer items across configured dimensions.
 *
 * @param items Array of MaintainerItems
 * @param filter WorklistFilter criteria
 * @returns Filtered array of MaintainerItems
 */
export function filterWorklist(items: MaintainerItem[], filter: WorklistFilter): MaintainerItem[] {
  return items.filter((item) => {
    if (filter.type !== undefined && item.type !== filter.type) {
      return false;
    }
    if (filter.category !== undefined && item.category !== filter.category) {
      return false;
    }
    if (filter.urgency !== undefined && item.urgency !== filter.urgency) {
      return false;
    }
    if (filter.risk !== undefined) {
      if (filter.risk === "security" && !item.securityRisk) return false;
      if (filter.risk === "breaking_change" && !item.breakingChangeRisk) return false;
      if (filter.risk === "data_loss" && !item.dataLossRisk) return false;
    }
    if (filter.isDuplicateCandidate !== undefined && item.isDuplicateCandidate !== filter.isDuplicateCandidate) {
      return false;
    }
    if (filter.isConfirmedDuplicate !== undefined && item.isConfirmedDuplicate !== filter.isConfirmedDuplicate) {
      return false;
    }
    if (filter.isSupersededCandidate !== undefined && item.isSupersededCandidate !== filter.isSupersededCandidate) {
      return false;
    }
    if (filter.readyForAction !== undefined && item.readyForAction !== filter.readyForAction) {
      return false;
    }
    if (filter.needsInformation !== undefined && Boolean(item.missingInformation) !== filter.needsInformation) {
      return false;
    }
    if (filter.lightweightReviewPending !== undefined) {
      const isPending =
        item.type === "pr" &&
        !item.hasDeepReview &&
        (item.advisoryRoute === "routine_review" ||
          item.advisoryRoute === "lightweight_review" ||
          item.escalateToDeepReview === false);
      if (isPending !== filter.lightweightReviewPending) {
        return false;
      }
    }
    if (filter.complexReviewRequired !== undefined) {
      const isComplex =
        item.escalateToDeepReview === true ||
        item.advisoryRoute === "expert_investigation" ||
        item.advisoryRoute === "security_escalation" ||
        item.advisoryRoute === "deep_review" ||
        item.suggestedAction === "needs_deep_review";
      if (isComplex !== filter.complexReviewRequired) {
        return false;
      }
    }
    if (filter.alreadyReviewed !== undefined && item.hasDeepReview !== filter.alreadyReviewed) {
      return false;
    }
    if (filter.hasStaleEvidence !== undefined) {
      const hasStale = item.jevDecisionAge === "stale" || item.deepReviewAge === "stale";
      if (hasStale !== filter.hasStaleEvidence) {
        return false;
      }
    }
    return true;
  });
}

const urgencyRank: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Sorts maintainer items by the chosen field and direction, using item number desc as tie-breaker.
 *
 * @param items Array of MaintainerItems
 * @param sort WorklistSort options
 * @returns Sorted array of MaintainerItems
 */
export function sortWorklist(items: MaintainerItem[], sort: WorklistSort): MaintainerItem[] {
  const { field, direction } = sort;
  const factor = direction === "desc" ? -1 : 1;

  return [...items].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case "urgency": {
        const uA = a.urgency ? (urgencyRank[a.urgency] ?? 0) : 0;
        const uB = b.urgency ? (urgencyRank[b.urgency] ?? 0) : 0;
        cmp = uA - uB;
        break;
      }
      case "category": {
        const cA = a.category ?? "";
        const cB = b.category ?? "";
        cmp = cA.localeCompare(cB);
        break;
      }
      case "number": {
        cmp = a.number - b.number;
        break;
      }
      case "updatedAt": {
        const tA = new Date(a.updatedAt).getTime() || 0;
        const tB = new Date(b.updatedAt).getTime() || 0;
        cmp = tA - tB;
        break;
      }
      case "score": {
        const sA = a.qualityScore ?? 0;
        const sB = b.qualityScore ?? 0;
        cmp = sA - sB;
        break;
      }
      default:
        cmp = 0;
    }

    if (cmp !== 0) {
      return factor * cmp;
    }

    // Stable deterministic tie-breaker
    return b.number - a.number;
  });
}

/**
 * Paginates maintainer items given offset and limit bounds.
 *
 * @param items Array of MaintainerItems
 * @param page WorklistPage pagination bounds
 * @returns Sliced items and hasMore indicator
 */
export function paginateWorklist(
  items: MaintainerItem[],
  page: WorklistPage,
): { items: MaintainerItem[]; hasMore: boolean } {
  const offset = Math.max(0, page.offset);
  const limit = Math.max(0, page.limit);
  const pagedItems = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return { items: pagedItems, hasMore };
}

/**
 * Core entry point for building the maintainer worklist.
 *
 * Combines stored items, Jev decisions, duplicate clusters, and reviews into
 * canonical MaintainerItem rows, applying requested filters, sorting, and pagination.
 *
 * @param options WorklistBuildOptions
 * @returns WorklistResult containing items, counts, and page metadata
 */
export function buildWorklist(options: WorklistBuildOptions): WorklistResult {
  const { store, repo, clusters, jevStore, filter, sort, page } = options;

  const rawItems = getStoreItems(store, repo);

  const storeItemsMap = new Map<string, PRItem>();
  for (const it of rawItems) {
    storeItemsMap.set(`${it.type}:${it.number}`, it);
    storeItemsMap.set(String(it.number), it);
  }

  const clusterMap = buildClusterMembershipMap(clusters);
  const decisionMap = jevStore ? buildDecisionMap(jevStore, repo) : new Map();

  const clusterItemMap = new Map<number, ScoredPR>();
  for (const c of clusters) {
    for (const item of c.items) {
      clusterItemMap.set(item.number, item);
    }
  }

  const maintainerItems: MaintainerItem[] = rawItems.map((item) => {
    const membership = clusterMap.get(item.number);
    const decision = decisionMap.get(item.number);
    const rawReview = store.getReview(repo, item.number);
    const reviewResult = getReviewResult(store, repo, item.number, options.queue);
    const scoredPR = clusterItemMap.get(item.number);

    return buildMaintainerItem({
      item,
      membership,
      decision,
      rawReview,
      reviewResult,
      scoredPR,
      storeItemsMap,
      clusters,
    });
  });

  const total = maintainerItems.length;

  const filteredItems = filter ? filterWorklist(maintainerItems, filter) : maintainerItems;
  const filtered = filteredItems.length;

  const sortedItems = sort
    ? sortWorklist(filteredItems, sort)
    : sortWorklist(filteredItems, { field: "number", direction: "desc" });

  let resultItems: MaintainerItem[];
  let pageMeta: { offset: number; limit: number; hasMore: boolean };

  if (page) {
    const paged = paginateWorklist(sortedItems, page);
    resultItems = paged.items;
    pageMeta = { offset: page.offset, limit: page.limit, hasMore: paged.hasMore };
  } else {
    resultItems = sortedItems;
    pageMeta = { offset: 0, limit: sortedItems.length, hasMore: false };
  }

  return {
    items: resultItems,
    total,
    filtered,
    page: pageMeta,
  };
}

/**
 * Default implementation of MaintainerAdapterPort backed by buildWorklist.
 */
export class DefaultMaintainerAdapter implements MaintainerAdapterPort {
  private options: Omit<WorklistBuildOptions, "repo">;

  constructor(options: Omit<WorklistBuildOptions, "repo">) {
    this.options = options;
  }

  async getItems(repo: string): Promise<MaintainerItem[]> {
    const result = buildWorklist({
      ...this.options,
      repo,
    });
    return result.items;
  }
}
