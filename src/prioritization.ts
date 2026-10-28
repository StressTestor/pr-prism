/**
 * Stage C — Transparent Deterministic Ranking and GLM Escalation Policy
 *
 * Retains PR-Prism's existing objective ranking signals (`src/scorer.ts`) and adds
 * TypeSafe Jev (`jev-1.14.0`) typed decisions, GitHub metadata, semantic duplicate
 * relationships, deterministic high-risk rules, and missing-information/uncertainty
 * flags as separately inspectable features.
 *
 * Key Guarantees:
 * - Never replaces PR-Prism's objective score with a single opaque AI judgment.
 * - Treats Pull Requests and Issues separately with dedicated feature breakdowns and formulas.
 * - Never automatically excludes potentially serious items based solely on low model-assigned risk
 *   (enforces deterministic safety gates, large-diff safeguards, truncation/missing-description
 *   safeguards, and borderline risk + production impact safeguards).
 * - Produces a 100% deterministic, reproducible GLM deep-review escalation queue.
 */

import type { PrismConfig } from "./config.js";
import {
  evaluateDeterministicSafetyGates,
  type JevComplexityTier,
  type JevFirstCategory,
  type JevFirstDecisionRecord,
  type JevPriorityTier,
} from "./decisions/triage-v2.js";
import { normalizeDescriptionQuality, scorePR } from "./scorer.js";
import type { Cluster, PRItem, ScoreSignals } from "./types.js";

export interface DuplicateRelationshipFeatures {
  clusterId: number | null;
  clusterSize: number;
  isClusterBestPick: boolean;
  isNonCanonicalDuplicate: boolean;
  isConfirmedIdentityDuplicate: boolean;
  clusterAvgSimilarity: number | null;
  closesIssueNumbers: number[];
  linkedPrNumbers: number[];
}

export interface InspectableJevFeatures {
  available: boolean;
  model: string | null;
  decisionIdentity: string | null;
  category: JevFirstCategory | "unknown";
  categoryConfidence: number | null;
  technicalDomain: string | null;
  priorityTier: JevPriorityTier | "unknown";
  complexityTier: JevComplexityTier | "unknown";
  operationalPriorityNorm: number | null;
  urgentBlockerProb: number | null;
  securityRiskProb: number | null;
  privacyRiskProb: number | null;
  dataLossRiskProb: number | null;
  breakingChangeRiskProb: number | null;
  maxSafetyRiskProb: number;
  productionImpactNorm: number | null;
  changeComplexityNorm: number | null;
  reproductionEvidenceNorm: number | null;
  missingInformationProb: number | null;
  goalRelevanceNorm: number | null;
  needsDeepReviewProb: number | null;
  advisoryRoute: string | null;
}

export interface InspectableGitHubMetadata {
  state: string;
  author: string;
  authorIsBot: boolean;
  labels: string[];
  ciStatus: "success" | "failure" | "pending" | "unknown";
  reviewCount: number;
  additions: number | null;
  deletions: number | null;
  totalDiffLines: number | null;
  changedFiles: number | null;
  hasTests: boolean | null;
  fullBodyLength: number;
  isInputTruncated: boolean;
  updatedAt: string;
}

export interface PrioritizationBreakdown {
  /** Existing PR-Prism objective score (0..1.05) from src/scorer.ts */
  objectiveBaseScore: number;
  /** Weighted contribution from Jev operational priority & production impact (0..1) */
  jevOperationalUrgencyComponent: number;
  /** Weighted contribution from Jev + deterministic safety/security/data-loss/breaking signals (0..1) */
  safetyAndRiskComponent: number;
  /** Weighted contribution from goal relevance & reproduction evidence (0..1) */
  relevanceAndEvidenceComponent: number;
  /** Adjustment from duplicate cluster status (canonical best pick bonus vs duplicate penalty) */
  duplicateClusterAdjustment: number;
  /** Explicit bonus for deterministic safety gate triggers (non-overridable) */
  deterministicSafetyBonus: number;
  /** Final transparent composite priority score used for deterministic queue ordering (0..100) */
  compositePriorityScore: number;
}

export interface PrioritizedItemBase {
  repo: string;
  number: number;
  type: "pr" | "issue";
  title: string;
  /** Existing PR-Prism objective signals from src/scorer.ts */
  objectiveSignals: ScoreSignals;
  /** Existing PR-Prism objective score from src/scorer.ts */
  objectiveScore: number;
  /** Separately inspectable GitHub metadata */
  githubMetadata: InspectableGitHubMetadata;
  /** Separately inspectable semantic duplicate relationships */
  duplicateFeatures: DuplicateRelationshipFeatures;
  /** Separately inspectable Jev typed decisions and probabilities */
  jevFeatures: InspectableJevFeatures;
  /** Non-overridable deterministic high-risk rules triggered */
  deterministicSafetyGates: string[];
  /** Missing-information, truncation, and uncertainty flags */
  uncertaintyAndMissingFlags: string[];
  /** Transparent score decomposition */
  breakdown: PrioritizationBreakdown;
  /** Whether this item is escalated to the GLM deep-review queue */
  escalateToGlm: boolean;
  /** Explicit, auditable reasons why this item was escalated (or why it remained local-only) */
  escalationReasons: string[];
  /** Priority tier assigned for queue scheduling */
  escalationBand: "P0_CRITICAL" | "P1_HIGH" | "P2_MODERATE" | "P3_ROUTINE_LOCAL";
}

export interface PrioritizedPRItem extends PrioritizedItemBase {
  type: "pr";
  prSpecific: {
    isLargeUnverifiedDiff: boolean;
    hasFailingCiWithHighImpact: boolean;
    mergeReadinessTier: "ready_candidate" | "needs_deep_review" | "needs_ci_or_tests" | "duplicate_candidate";
  };
}

export interface PrioritizedIssueItem extends PrioritizedItemBase {
  type: "issue";
  issueSpecific: {
    hasLinkedOpenPR: boolean;
    linkedOpenPrNumbers: number[];
    triageActionability:
      | "security_or_critical_escalation"
      | "actionable_with_pr"
      | "needs_deep_architecture_triage"
      | "needs_reproduction_info"
      | "routine_backlog";
  };
}

export interface EscalationQueueEntry {
  rank: number;
  itemTypeRank: number;
  repo: string;
  itemType: "pr" | "issue";
  number: number;
  title: string;
  escalationBand: "P0_CRITICAL" | "P1_HIGH" | "P2_MODERATE";
  compositePriorityScore: number;
  objectiveScore: number;
  jevCategory: string;
  jevPriorityTier: string;
  jevComplexityTier: string;
  maxSafetyRiskProb: number;
  needsDeepReviewProb: number | null;
  deterministicSafetyGates: string[];
  uncertaintyAndMissingFlags: string[];
  escalationReasons: string[];
  duplicateClusterId: number | null;
  isClusterBestPick: boolean;
  decisionIdentity: string | null;
}

export interface ReproducibleEscalationQueue {
  schemaVersion: "1.0.0";
  repo: string;
  generatedAt: string;
  summary: {
    totalOpenItems: number;
    totalOpenPRs: number;
    totalOpenIssues: number;
    escalatedPRs: number;
    localOnlyPRs: number;
    escalatedIssues: number;
    localOnlyIssues: number;
    totalEscalated: number;
    bandCounts: Record<"P0_CRITICAL" | "P1_HIGH" | "P2_MODERATE" | "P3_ROUTINE_LOCAL", number>;
  };
  prioritizedPRs: PrioritizedPRItem[];
  prioritizedIssues: PrioritizedIssueItem[];
  prEscalationQueue: EscalationQueueEntry[];
  issueEscalationQueue: EscalationQueueEntry[];
  combinedEscalationQueue: EscalationQueueEntry[];
}

export interface PrioritizationInputOptions {
  items: PRItem[];
  jevDecisionsByKey?: Map<string, JevFirstDecisionRecord>;
  clusters?: Cluster[];
  authorMergeCounts?: Map<string, number>;
  fullBodyLengthsByKey?: Map<string, number>;
  config?: PrismConfig;
  generatedAt?: string;
}

const DEFAULT_SCORING_CONFIG = {
  scoring: {
    weights: {
      has_tests: 0.25,
      ci_passing: 0.25,
      diff_size_penalty: 0.15,
      author_history: 0.15,
      description_quality: 0.1,
      review_approvals: 0.1,
    },
  },
} as unknown as PrismConfig;

export function makeItemKey(type: "pr" | "issue", number: number): string {
  return `${type}:${number}`;
}

function buildDuplicateLookup(items: PRItem[], clusters: Cluster[] = []): Map<string, DuplicateRelationshipFeatures> {
  const map = new Map<string, DuplicateRelationshipFeatures>();

  // Map issues to PRs that close them
  const issueToLinkedPRs = new Map<number, number[]>();
  for (const item of items) {
    if (item.type === "pr" && Array.isArray(item.closesIssues)) {
      for (const issueNum of item.closesIssues) {
        const list = issueToLinkedPRs.get(issueNum) || [];
        if (!list.includes(item.number)) {
          list.push(item.number);
        }
        issueToLinkedPRs.set(issueNum, list);
      }
    }
  }

  // Initialize default entries
  for (const item of items) {
    const key = makeItemKey(item.type, item.number);
    map.set(key, {
      clusterId: null,
      clusterSize: 1,
      isClusterBestPick: true,
      isNonCanonicalDuplicate: false,
      isConfirmedIdentityDuplicate: false,
      clusterAvgSimilarity: null,
      closesIssueNumbers: item.type === "pr" ? [...(item.closesIssues || [])].sort((a, b) => a - b) : [],
      linkedPrNumbers:
        item.type === "issue" ? [...(issueToLinkedPRs.get(item.number) || [])].sort((a, b) => a - b) : [],
    });
  }

  for (const cluster of clusters) {
    for (const member of cluster.items) {
      const key = makeItemKey(member.type, member.number);
      const isBestPick = cluster.bestPick.number === member.number && cluster.bestPick.type === member.type;
      const existing = map.get(key);
      map.set(key, {
        clusterId: cluster.id,
        clusterSize: cluster.items.length,
        isClusterBestPick: isBestPick,
        isNonCanonicalDuplicate: cluster.items.length > 1 && !isBestPick,
        isConfirmedIdentityDuplicate: cluster.kind === "identity",
        clusterAvgSimilarity: cluster.avgSimilarity,
        closesIssueNumbers: existing?.closesIssueNumbers || [],
        linkedPrNumbers: existing?.linkedPrNumbers || [],
      });
    }
  }

  return map;
}

function extractInspectableJevFeatures(jev?: JevFirstDecisionRecord): InspectableJevFeatures {
  if (!jev) {
    return {
      available: false,
      model: null,
      decisionIdentity: null,
      category: "unknown",
      categoryConfidence: null,
      technicalDomain: null,
      priorityTier: "unknown",
      complexityTier: "unknown",
      operationalPriorityNorm: null,
      urgentBlockerProb: null,
      securityRiskProb: null,
      privacyRiskProb: null,
      dataLossRiskProb: null,
      breakingChangeRiskProb: null,
      maxSafetyRiskProb: 0,
      productionImpactNorm: null,
      changeComplexityNorm: null,
      reproductionEvidenceNorm: null,
      missingInformationProb: null,
      goalRelevanceNorm: null,
      needsDeepReviewProb: null,
      advisoryRoute: null,
    };
  }

  const maxSafetyRiskProb = Math.max(
    jev.scores.securityVulnerabilityProb ?? 0,
    jev.scores.privacyOrPiiProb ?? 0,
    jev.scores.dataLossOrCorruptionProb ?? 0,
    jev.scores.breakingChangeProb ?? 0,
  );

  return {
    available: true,
    model: jev.provenance.model,
    decisionIdentity: jev.provenance.decisionIdentity,
    category: jev.classification.category,
    categoryConfidence: jev.classification.categoryConfidence,
    technicalDomain: jev.classification.technicalDomain,
    priorityTier: jev.derived.priorityTier,
    complexityTier: jev.derived.complexityTier,
    operationalPriorityNorm: jev.scores.operationalPriorityNorm,
    urgentBlockerProb: jev.scores.urgentBlockerProb,
    securityRiskProb: jev.scores.securityVulnerabilityProb,
    privacyRiskProb: jev.scores.privacyOrPiiProb,
    dataLossRiskProb: jev.scores.dataLossOrCorruptionProb,
    breakingChangeRiskProb: jev.scores.breakingChangeProb,
    maxSafetyRiskProb: Number(maxSafetyRiskProb.toFixed(4)),
    productionImpactNorm: jev.scores.productionImpactNorm,
    changeComplexityNorm: jev.scores.changeComplexityNorm,
    reproductionEvidenceNorm: jev.scores.reproductionEvidenceNorm,
    missingInformationProb: jev.scores.missingInformationProb,
    goalRelevanceNorm: jev.scores.goalRelevanceNorm,
    needsDeepReviewProb: jev.scores.needsDeepReviewProb,
    advisoryRoute: jev.routing.advisoryRoute,
  };
}

/**
 * Prioritizes Pull Requests separately from Issues, combining objective PR-Prism signals,
 * GitHub diff/CI/test metadata, duplicate cluster signals, Jev typed decisions,
 * deterministic safety gates, and missing-evidence safeguards.
 */
export function prioritizePullRequests(
  prItems: PRItem[],
  options: Omit<PrioritizationInputOptions, "items"> = {},
): PrioritizedPRItem[] {
  const config = options.config || DEFAULT_SCORING_CONFIG;
  const authorMergeCounts = options.authorMergeCounts || new Map<string, number>();
  const dupLookup = buildDuplicateLookup(prItems, options.clusters);

  const results: PrioritizedPRItem[] = [];

  for (const item of prItems) {
    if (item.type !== "pr") continue;
    const key = makeItemKey("pr", item.number);
    const jev = options.jevDecisionsByKey?.get(key);
    const fullBodyLength =
      options.fullBodyLengthsByKey?.get(key) ?? jev?.item.fullBodyLength ?? (item.body ? item.body.length : 0);
    const isInputTruncated = jev?.item.isInputTruncated ?? fullBodyLength > 14000;

    // 1. Existing PR-Prism objective score & signals
    const scored = scorePR(item, config, { authorMergeCounts });
    // Re-normalize descriptionQuality with fullBodyLength if sidecar length is known
    const updatedDescQuality = normalizeDescriptionQuality(item.body || "", fullBodyLength);
    const objectiveSignals: ScoreSignals = {
      ...scored.signals,
      descriptionQuality: updatedDescQuality,
    };
    const objectiveScore = Number(scored.score.toFixed(4));

    // 2. GitHub Metadata
    const additions = item.additions ?? null;
    const deletions = item.deletions ?? null;
    const totalDiffLines = additions !== null && deletions !== null ? additions + deletions : null;
    const githubMetadata: InspectableGitHubMetadata = {
      state: item.state,
      author: item.author,
      authorIsBot: Boolean(item.authorIsBot),
      labels: item.labels || [],
      ciStatus: item.ciStatus || "unknown",
      reviewCount: item.reviewCount ?? 0,
      additions,
      deletions,
      totalDiffLines,
      changedFiles: item.changedFiles ?? null,
      hasTests: item.hasTests ?? null,
      fullBodyLength,
      isInputTruncated,
      updatedAt: item.updatedAt,
    };

    // 3. Duplicate cluster features
    const duplicateFeatures = dupLookup.get(key)!;

    // 4. Jev inspectable features
    const jevFeatures = extractInspectableJevFeatures(jev);

    // 5. Deterministic safety gates (non-overridable)
    const deterministicSafetyGates = Array.from(
      new Set([...evaluateDeterministicSafetyGates(item), ...(jev?.routing.deterministicSafetyGates || [])]),
    );

    // 6. Missing-information, truncation & uncertainty flags
    const uncertaintyFlags = new Set<string>(jev?.routing.uncertaintyFlags || []);
    if (!jevFeatures.available) {
      uncertaintyFlags.add("jev_decision_unavailable");
    }
    if (isInputTruncated) {
      uncertaintyFlags.add("input_truncated_over_14k");
    }
    if (fullBodyLength === 0) {
      uncertaintyFlags.add("empty_pr_description");
    }
    const isRoutineDocOrTest = jevFeatures.category === "documentation" || jevFeatures.category === "tests";
    const isLargeUnverifiedDiff =
      !isRoutineDocOrTest &&
      ((totalDiffLines !== null && totalDiffLines >= 500) ||
        (totalDiffLines !== null && totalDiffLines >= 250 && item.hasTests === false));
    if (isLargeUnverifiedDiff) {
      uncertaintyFlags.add("large_or_untested_diff");
    }
    if (totalDiffLines === null) {
      uncertaintyFlags.add("missing_diff_stats");
    }

    // 7. Escalation Policy for PRs (including Seriousness Floor so low model risk never hides serious PRs)
    const escalationReasons: string[] = [...(jev?.routing.escalationReasons || [])];

    for (const gate of deterministicSafetyGates) {
      if (!escalationReasons.includes(gate)) {
        escalationReasons.push(gate);
      }
    }

    // Seriousness Floor 1: Large diff (>= 500 lines) or >= 250 lines without tests on non-doc/test PR
    if (isLargeUnverifiedDiff) {
      escalationReasons.push(
        `seriousness_floor:large_or_untested_diff(lines=${totalDiffLines},hasTests=${String(item.hasTests)})`,
      );
    }

    // Seriousness Floor 2: Borderline safety risk (>= 0.25) combined with production impact (>= 0.45) or CI failure
    if (
      jevFeatures.maxSafetyRiskProb >= 0.25 &&
      ((jevFeatures.productionImpactNorm ?? 0) >= 0.45 || githubMetadata.ciStatus === "failure")
    ) {
      escalationReasons.push(
        `seriousness_floor:borderline_safety_with_impact(risk=${jevFeatures.maxSafetyRiskProb.toFixed(2)})`,
      );
    }

    // Seriousness Floor 3: Missing Jev evaluation fails closed to escalation on non-doc PRs
    if (!jevFeatures.available) {
      escalationReasons.push("seriousness_floor:jev_decision_unavailable");
    }

    // Seriousness Floor 4: Low category concentration (< 0.55) on code PR
    if (jevFeatures.categoryConfidence !== null && jevFeatures.categoryConfidence < 0.55) {
      escalationReasons.push(`seriousness_floor:low_category_confidence(${jevFeatures.categoryConfidence.toFixed(2)})`);
    }

    // Seriousness Floor 5: Empty description on non-trivial PR
    if (fullBodyLength === 0 && !isRoutineDocOrTest) {
      escalationReasons.push("seriousness_floor:empty_pr_description");
    }

    const uniqueEscalationReasons = Array.from(new Set(escalationReasons));
    const escalateToGlm = uniqueEscalationReasons.length > 0;

    // 8. Transparent Composite Priority Score for PRs (0..100 scale)
    const objectiveBaseScore = Math.min(1, Math.max(0, objectiveScore));
    const jevOperationalUrgencyComponent = jevFeatures.available
      ? 0.45 * (jevFeatures.operationalPriorityNorm ?? 0.33) +
        0.35 * (jevFeatures.productionImpactNorm ?? 0.5) +
        0.2 * (jevFeatures.urgentBlockerProb ?? 0)
      : 0.4;
    const safetyAndRiskComponent = Math.min(
      1,
      Math.max(
        jevFeatures.maxSafetyRiskProb,
        0.7 * (jevFeatures.needsDeepReviewProb ?? 0) + 0.3 * (jevFeatures.changeComplexityNorm ?? 0.5),
      ),
    );
    const relevanceAndEvidenceComponent = jevFeatures.available
      ? 0.6 * (jevFeatures.goalRelevanceNorm ?? 0.5) + 0.4 * (jevFeatures.reproductionEvidenceNorm ?? 0.5)
      : 0.5;

    let duplicateClusterAdjustment = 0;
    if (duplicateFeatures.closesIssueNumbers.length > 0) {
      duplicateClusterAdjustment += 3.0; // Links & resolves tracked issue(s)
    }
    if (duplicateFeatures.clusterSize > 1 && duplicateFeatures.isClusterBestPick) {
      duplicateClusterAdjustment += 2.5; // Canonical best pick of duplicate cluster
    } else if (duplicateFeatures.isConfirmedIdentityDuplicate && !duplicateFeatures.isClusterBestPick) {
      duplicateClusterAdjustment -= 8.0; // Redundant identical head OID duplicate
    } else if (duplicateFeatures.isNonCanonicalDuplicate) {
      duplicateClusterAdjustment -= 3.5; // Fuzzy duplicate of higher-scored PR
    }

    const deterministicSafetyBonus = deterministicSafetyGates.length > 0 ? 15.0 : 0;

    const rawComposite =
      28.0 * objectiveBaseScore +
      27.0 * jevOperationalUrgencyComponent +
      25.0 * safetyAndRiskComponent +
      10.0 * relevanceAndEvidenceComponent +
      duplicateClusterAdjustment +
      deterministicSafetyBonus;

    const compositePriorityScore = Number(Math.max(0, Math.min(100, rawComposite)).toFixed(2));

    // Determine Escalation Band
    let escalationBand: PrioritizedItemBase["escalationBand"] = "P3_ROUTINE_LOCAL";
    if (escalateToGlm) {
      if (
        deterministicSafetyGates.some(
          (g) => g.includes("security") || g.includes("data_loss") || g.includes("priority_label"),
        ) ||
        jevFeatures.priorityTier === "critical" ||
        jevFeatures.maxSafetyRiskProb >= 0.75 ||
        (jevFeatures.urgentBlockerProb ?? 0) >= 0.65
      ) {
        escalationBand = "P0_CRITICAL";
      } else if (
        jevFeatures.priorityTier === "high" ||
        jevFeatures.maxSafetyRiskProb >= 0.42 ||
        (jevFeatures.needsDeepReviewProb ?? 0) >= 0.5 ||
        deterministicSafetyGates.length > 0 ||
        compositePriorityScore >= 60
      ) {
        escalationBand = "P1_HIGH";
      } else {
        escalationBand = "P2_MODERATE";
      }
    }

    const hasFailingCiWithHighImpact =
      githubMetadata.ciStatus === "failure" && (jevFeatures.productionImpactNorm ?? 0) >= 0.5;

    let mergeReadinessTier: PrioritizedPRItem["prSpecific"]["mergeReadinessTier"] = "ready_candidate";
    if (duplicateFeatures.isNonCanonicalDuplicate) {
      mergeReadinessTier = "duplicate_candidate";
    } else if (escalateToGlm) {
      mergeReadinessTier = "needs_deep_review";
    } else if (githubMetadata.ciStatus === "failure" || item.hasTests === false) {
      mergeReadinessTier = "needs_ci_or_tests";
    }

    results.push({
      repo: item.repo,
      number: item.number,
      type: "pr",
      title: item.title,
      objectiveSignals,
      objectiveScore,
      githubMetadata,
      duplicateFeatures,
      jevFeatures,
      deterministicSafetyGates,
      uncertaintyAndMissingFlags: Array.from(uncertaintyFlags),
      breakdown: {
        objectiveBaseScore: Number(objectiveBaseScore.toFixed(4)),
        jevOperationalUrgencyComponent: Number(jevOperationalUrgencyComponent.toFixed(4)),
        safetyAndRiskComponent: Number(safetyAndRiskComponent.toFixed(4)),
        relevanceAndEvidenceComponent: Number(relevanceAndEvidenceComponent.toFixed(4)),
        duplicateClusterAdjustment: Number(duplicateClusterAdjustment.toFixed(2)),
        deterministicSafetyBonus: Number(deterministicSafetyBonus.toFixed(2)),
        compositePriorityScore,
      },
      escalateToGlm,
      escalationReasons: uniqueEscalationReasons,
      escalationBand,
      prSpecific: {
        isLargeUnverifiedDiff,
        hasFailingCiWithHighImpact,
        mergeReadinessTier,
      },
    });
  }

  return sortPrioritizedItems(results);
}

/**
 * Prioritizes Issues separately from Pull Requests using an issue-specific formula that
 * does not penalize issues for lacking PR-only fields (diff size, CI status, review count).
 */
export function prioritizeIssues(
  allItems: PRItem[],
  options: Omit<PrioritizationInputOptions, "items"> = {},
): PrioritizedIssueItem[] {
  const authorMergeCounts = options.authorMergeCounts || new Map<string, number>();
  const dupLookup = buildDuplicateLookup(allItems, options.clusters);
  const config = options.config || DEFAULT_SCORING_CONFIG;

  const results: PrioritizedIssueItem[] = [];

  for (const item of allItems) {
    if (item.type !== "issue") continue;
    const key = makeItemKey("issue", item.number);
    const jev = options.jevDecisionsByKey?.get(key);
    const fullBodyLength =
      options.fullBodyLengthsByKey?.get(key) ?? jev?.item.fullBodyLength ?? (item.body ? item.body.length : 0);
    const isInputTruncated = jev?.item.isInputTruncated ?? fullBodyLength > 14000;

    // 1. Existing PR-Prism objective signals (using issue-appropriate description quality, recency, author history)
    const scored = scorePR(item, config, { authorMergeCounts });
    const updatedDescQuality = normalizeDescriptionQuality(item.body || "", fullBodyLength);
    const objectiveSignals: ScoreSignals = {
      ...scored.signals,
      descriptionQuality: updatedDescQuality,
    };
    // For issues, objective base quality combines description completeness (60%), recency (25%), and author history (15%)
    const issueObjectiveScore = Number(
      (0.6 * updatedDescQuality + 0.25 * (scored.signals.recency ?? 0.5) + 0.15 * scored.signals.authorHistory).toFixed(
        4,
      ),
    );

    // 2. GitHub Metadata
    const githubMetadata: InspectableGitHubMetadata = {
      state: item.state,
      author: item.author,
      authorIsBot: Boolean(item.authorIsBot),
      labels: item.labels || [],
      ciStatus: "unknown",
      reviewCount: 0,
      additions: null,
      deletions: null,
      totalDiffLines: null,
      changedFiles: null,
      hasTests: null,
      fullBodyLength,
      isInputTruncated,
      updatedAt: item.updatedAt,
    };

    // 3. Duplicate & Linked PR relationship features
    const duplicateFeatures = dupLookup.get(key)!;

    // 4. Jev inspectable features
    const jevFeatures = extractInspectableJevFeatures(jev);

    // 5. Deterministic safety gates (non-overridable)
    const deterministicSafetyGates = Array.from(
      new Set([...evaluateDeterministicSafetyGates(item), ...(jev?.routing.deterministicSafetyGates || [])]),
    );

    // 6. Missing-information, truncation & uncertainty flags
    const uncertaintyFlags = new Set<string>(jev?.routing.uncertaintyFlags || []);
    if (!jevFeatures.available) {
      uncertaintyFlags.add("jev_decision_unavailable");
    }
    if (isInputTruncated) {
      uncertaintyFlags.add("input_truncated_over_14k");
    }
    if (fullBodyLength < 40) {
      uncertaintyFlags.add("minimal_or_empty_issue_body");
    }
    if ((jevFeatures.reproductionEvidenceNorm ?? 1) < 0.35 && jevFeatures.category === "bug") {
      uncertaintyFlags.add("missing_reproduction_steps");
    }

    // 7. Escalation Policy for Issues (including Seriousness Floor)
    const escalationReasons: string[] = [...(jev?.routing.escalationReasons || [])];

    for (const gate of deterministicSafetyGates) {
      if (!escalationReasons.includes(gate)) {
        escalationReasons.push(gate);
      }
    }

    // Seriousness Floor 1: Borderline safety risk (>= 0.25) with high production impact (>= 0.55)
    if (jevFeatures.maxSafetyRiskProb >= 0.25 && (jevFeatures.productionImpactNorm ?? 0) >= 0.55) {
      escalationReasons.push(
        `seriousness_floor:borderline_safety_with_severe_impact(risk=${jevFeatures.maxSafetyRiskProb.toFixed(2)})`,
      );
    }

    // Seriousness Floor 2: Missing Jev decision fails closed
    if (!jevFeatures.available) {
      escalationReasons.push("seriousness_floor:jev_decision_unavailable");
    }

    // Seriousness Floor 3: Severe production impact (>= 0.85) on bug/security/performance issue even if priority was medium
    if (
      (jevFeatures.productionImpactNorm ?? 0) >= 0.85 &&
      (jevFeatures.category === "bug" || jevFeatures.category === "security" || jevFeatures.category === "performance")
    ) {
      escalationReasons.push(
        `seriousness_floor:severe_production_impact(${(jevFeatures.productionImpactNorm ?? 0).toFixed(2)})`,
      );
    }

    const uniqueEscalationReasons = Array.from(new Set(escalationReasons));
    const escalateToGlm = uniqueEscalationReasons.length > 0;

    // 8. Transparent Composite Priority Score for Issues (0..100 scale)
    const objectiveBaseScore = Math.min(1, Math.max(0, issueObjectiveScore));
    const jevOperationalUrgencyComponent = jevFeatures.available
      ? 0.45 * (jevFeatures.operationalPriorityNorm ?? 0.33) +
        0.35 * (jevFeatures.productionImpactNorm ?? 0.5) +
        0.2 * (jevFeatures.urgentBlockerProb ?? 0)
      : 0.4;
    const safetyAndRiskComponent = Math.min(
      1,
      Math.max(
        jevFeatures.maxSafetyRiskProb,
        0.65 * (jevFeatures.needsDeepReviewProb ?? 0) + 0.35 * (jevFeatures.changeComplexityNorm ?? 0.5),
      ),
    );
    const relevanceAndEvidenceComponent = jevFeatures.available
      ? 0.55 * (jevFeatures.goalRelevanceNorm ?? 0.5) + 0.45 * (jevFeatures.reproductionEvidenceNorm ?? 0.5)
      : 0.5;

    let duplicateClusterAdjustment = 0;
    if (duplicateFeatures.linkedPrNumbers.length > 0) {
      duplicateClusterAdjustment += 2.5; // Has an active linked PR addressing it
    }
    if (duplicateFeatures.clusterSize > 1 && duplicateFeatures.isClusterBestPick) {
      duplicateClusterAdjustment += 2.0;
    } else if (duplicateFeatures.isNonCanonicalDuplicate) {
      duplicateClusterAdjustment -= 4.0;
    }

    const deterministicSafetyBonus = deterministicSafetyGates.length > 0 ? 15.0 : 0;

    const rawComposite =
      18.0 * objectiveBaseScore +
      32.0 * jevOperationalUrgencyComponent +
      27.0 * safetyAndRiskComponent +
      13.0 * relevanceAndEvidenceComponent +
      duplicateClusterAdjustment +
      deterministicSafetyBonus;

    const compositePriorityScore = Number(Math.max(0, Math.min(100, rawComposite)).toFixed(2));

    let escalationBand: PrioritizedItemBase["escalationBand"] = "P3_ROUTINE_LOCAL";
    if (escalateToGlm) {
      if (
        deterministicSafetyGates.some(
          (g) => g.includes("security") || g.includes("data_loss") || g.includes("priority_label"),
        ) ||
        jevFeatures.priorityTier === "critical" ||
        jevFeatures.maxSafetyRiskProb >= 0.75 ||
        (jevFeatures.urgentBlockerProb ?? 0) >= 0.65
      ) {
        escalationBand = "P0_CRITICAL";
      } else if (
        jevFeatures.priorityTier === "high" ||
        jevFeatures.maxSafetyRiskProb >= 0.42 ||
        (jevFeatures.needsDeepReviewProb ?? 0) >= 0.5 ||
        deterministicSafetyGates.length > 0 ||
        compositePriorityScore >= 58
      ) {
        escalationBand = "P1_HIGH";
      } else {
        escalationBand = "P2_MODERATE";
      }
    }

    let triageActionability: PrioritizedIssueItem["issueSpecific"]["triageActionability"] = "routine_backlog";
    if (escalationBand === "P0_CRITICAL" || jevFeatures.category === "security") {
      triageActionability = "security_or_critical_escalation";
    } else if (duplicateFeatures.linkedPrNumbers.length > 0) {
      triageActionability = "actionable_with_pr";
    } else if (escalateToGlm) {
      triageActionability = "needs_deep_architecture_triage";
    } else if ((jevFeatures.reproductionEvidenceNorm ?? 1) < 0.35 && jevFeatures.category === "bug") {
      triageActionability = "needs_reproduction_info";
    }

    results.push({
      repo: item.repo,
      number: item.number,
      type: "issue",
      title: item.title,
      objectiveSignals,
      objectiveScore: issueObjectiveScore,
      githubMetadata,
      duplicateFeatures,
      jevFeatures,
      deterministicSafetyGates,
      uncertaintyAndMissingFlags: Array.from(uncertaintyFlags),
      breakdown: {
        objectiveBaseScore: Number(objectiveBaseScore.toFixed(4)),
        jevOperationalUrgencyComponent: Number(jevOperationalUrgencyComponent.toFixed(4)),
        safetyAndRiskComponent: Number(safetyAndRiskComponent.toFixed(4)),
        relevanceAndEvidenceComponent: Number(relevanceAndEvidenceComponent.toFixed(4)),
        duplicateClusterAdjustment: Number(duplicateClusterAdjustment.toFixed(2)),
        deterministicSafetyBonus: Number(deterministicSafetyBonus.toFixed(2)),
        compositePriorityScore,
      },
      escalateToGlm,
      escalationReasons: uniqueEscalationReasons,
      escalationBand,
      issueSpecific: {
        hasLinkedOpenPR: duplicateFeatures.linkedPrNumbers.length > 0,
        linkedOpenPrNumbers: duplicateFeatures.linkedPrNumbers,
        triageActionability,
      },
    });
  }

  return sortPrioritizedItems(results);
}

const BAND_ORDER: Record<PrioritizedItemBase["escalationBand"], number> = {
  P0_CRITICAL: 0,
  P1_HIGH: 1,
  P2_MODERATE: 2,
  P3_ROUTINE_LOCAL: 3,
};

function sortPrioritizedItems<T extends PrioritizedItemBase>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const bandDiff = BAND_ORDER[a.escalationBand] - BAND_ORDER[b.escalationBand];
    if (bandDiff !== 0) return bandDiff;
    const scoreDiff = b.breakdown.compositePriorityScore - a.breakdown.compositePriorityScore;
    if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
    const safetyDiff = b.jevFeatures.maxSafetyRiskProb - a.jevFeatures.maxSafetyRiskProb;
    if (Math.abs(safetyDiff) > 1e-6) return safetyDiff;
    const objDiff = b.objectiveScore - a.objectiveScore;
    if (Math.abs(objDiff) > 1e-6) return objDiff;
    if (a.type !== b.type) return a.type === "pr" ? -1 : 1;
    return a.number - b.number;
  });
}

function toQueueEntry(item: PrioritizedItemBase, rank: number, itemTypeRank: number): EscalationQueueEntry {
  return {
    rank,
    itemTypeRank,
    repo: item.repo,
    itemType: item.type,
    number: item.number,
    title: item.title,
    escalationBand: item.escalationBand as "P0_CRITICAL" | "P1_HIGH" | "P2_MODERATE",
    compositePriorityScore: item.breakdown.compositePriorityScore,
    objectiveScore: item.objectiveScore,
    jevCategory: item.jevFeatures.category,
    jevPriorityTier: item.jevFeatures.priorityTier,
    jevComplexityTier: item.jevFeatures.complexityTier,
    maxSafetyRiskProb: item.jevFeatures.maxSafetyRiskProb,
    needsDeepReviewProb: item.jevFeatures.needsDeepReviewProb,
    deterministicSafetyGates: item.deterministicSafetyGates,
    uncertaintyAndMissingFlags: item.uncertaintyAndMissingFlags,
    escalationReasons: item.escalationReasons,
    duplicateClusterId: item.duplicateFeatures.clusterId,
    isClusterBestPick: item.duplicateFeatures.isClusterBestPick,
    decisionIdentity: item.jevFeatures.decisionIdentity,
  };
}

/**
 * Builds the complete, deterministic, reproducible GLM escalation queue with
 * separate PR and Issue rankings as well as a unified priority-ordered queue.
 */
export function buildReproducibleEscalationQueue(options: PrioritizationInputOptions): ReproducibleEscalationQueue {
  const repo = options.items[0]?.repo || "unknown/unknown";
  const generatedAt = options.generatedAt || new Date().toISOString();

  const prioritizedPRs = prioritizePullRequests(options.items, options);
  const prioritizedIssues = prioritizeIssues(options.items, options);

  const escalatedPRItems = prioritizedPRs.filter((x) => x.escalateToGlm);
  const escalatedIssueItems = prioritizedIssues.filter((x) => x.escalateToGlm);

  const prEscalationQueue = escalatedPRItems.map((item, idx) => toQueueEntry(item, idx + 1, idx + 1));
  const issueEscalationQueue = escalatedIssueItems.map((item, idx) => toQueueEntry(item, idx + 1, idx + 1));

  // Combined queue interleaves by escalationBand -> compositePriorityScore -> PR before Issue tie-break
  const allEscalated = sortPrioritizedItems<PrioritizedItemBase>([...escalatedPRItems, ...escalatedIssueItems]);

  let prCounter = 0;
  let issueCounter = 0;
  const combinedEscalationQueue = allEscalated.map((item, idx) => {
    const typeRank = item.type === "pr" ? ++prCounter : ++issueCounter;
    return toQueueEntry(item, idx + 1, typeRank);
  });

  const bandCounts: Record<"P0_CRITICAL" | "P1_HIGH" | "P2_MODERATE" | "P3_ROUTINE_LOCAL", number> = {
    P0_CRITICAL: 0,
    P1_HIGH: 0,
    P2_MODERATE: 0,
    P3_ROUTINE_LOCAL: 0,
  };
  for (const p of prioritizedPRs) bandCounts[p.escalationBand]++;
  for (const i of prioritizedIssues) bandCounts[i.escalationBand]++;

  return {
    schemaVersion: "1.0.0",
    repo,
    generatedAt,
    summary: {
      totalOpenItems: prioritizedPRs.length + prioritizedIssues.length,
      totalOpenPRs: prioritizedPRs.length,
      totalOpenIssues: prioritizedIssues.length,
      escalatedPRs: prEscalationQueue.length,
      localOnlyPRs: prioritizedPRs.length - prEscalationQueue.length,
      escalatedIssues: issueEscalationQueue.length,
      localOnlyIssues: prioritizedIssues.length - issueEscalationQueue.length,
      totalEscalated: combinedEscalationQueue.length,
      bandCounts,
    },
    prioritizedPRs,
    prioritizedIssues,
    prEscalationQueue,
    issueEscalationQueue,
    combinedEscalationQueue,
  };
}
