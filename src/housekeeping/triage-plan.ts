/**
 * Task E — Efficient Routing and Triage Plan
 *
 * Reproducible triage plan module that integrates with the prioritization and escalation
 * queue, producing a stable JSON/TypeScript contract for the review scheduler.
 *
 * Priority order:
 * 1. Verified closure candidates (CLOSURE_CANDIDATES, for maintainer approval — no auto-close)
 * 2. Information requests (INFORMATION_REQUESTS)
 * 3. Routine lightweight reviews (LIGHT_REVIEW)
 * 4. Intermediate reviews (INTERMEDIATE_REVIEW)
 * 5. Complex reviews needed (COMPLEX_REVIEW_NEEDED — does NOT bind to any specific LLM)
 * 6. Maintainer decisions (MAINTAINER_DECISION)
 * 7. Ready for maintainer (READY_FOR_MAINTAINER, default)
 */

import type { PRItem } from "../types.js";

export const TRIAGE_PLAN_SCHEMA_VERSION = "1.0.0";
export const TRIAGE_SCHEDULER_CONTRACT_VERSION = "1.0.0";

export const REVIEW_CALL_AVOIDANCE_NOTE =
  "Estimated avoided review calls are based only on closure candidates with deterministic verification evidence. Unverified closure candidates are not counted.";

export type TriageActionGroup =
  | "CLOSURE_CANDIDATES" // verified closure candidates for maintainer approval
  | "INFORMATION_REQUESTS" // items needing more info before action
  | "LIGHT_REVIEW" // routine low-risk reviews
  | "INTERMEDIATE_REVIEW" // non-trivial, bounded complexity
  | "COMPLEX_REVIEW_NEEDED" // human/advanced AI review warranted (NOT automatic LLM)
  | "MAINTAINER_DECISION" // requires human policy judgment
  | "READY_FOR_MAINTAINER"; // queued, actionable, no special routing

export const TRIAGE_ACTION_GROUP_ORDER: readonly TriageActionGroup[] = [
  "CLOSURE_CANDIDATES",
  "INFORMATION_REQUESTS",
  "LIGHT_REVIEW",
  "INTERMEDIATE_REVIEW",
  "COMPLEX_REVIEW_NEEDED",
  "MAINTAINER_DECISION",
  "READY_FOR_MAINTAINER",
] as const;

const GROUP_PRIORITY_MAP: Record<TriageActionGroup, number> = {
  CLOSURE_CANDIDATES: 0,
  INFORMATION_REQUESTS: 1,
  LIGHT_REVIEW: 2,
  INTERMEDIATE_REVIEW: 3,
  COMPLEX_REVIEW_NEEDED: 4,
  MAINTAINER_DECISION: 5,
  READY_FOR_MAINTAINER: 6,
};

export interface TriagePlanEntry {
  rank: number; // global rank within triage plan (1-indexed)
  actionGroup: TriageActionGroup; // which group this entry belongs to
  itemType: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  actionSignal: string; // from ResolutionActionSignal or derived
  actionReason: string[]; // why this action
  estimatedReviewCallAvoided: boolean; // true only for CLOSURE_CANDIDATES with verified evidence
  evidenceForAvoidance?: string; // only present when estimatedReviewCallAvoided = true, must be from real signals
  closureCandidateVerified?: boolean; // only for CLOSURE_CANDIDATES
  priorityBand: string; // calibrated priority band
  requiresMaintainerApproval: boolean; // always true
}

export interface TriagePlanSummary {
  schemaVersion: string;
  generatedAt: string;
  repo: string;
  totalItems: number;
  totalPRs: number;
  totalIssues: number;

  // Group counts
  closureCandidates: number;
  informationRequests: number;
  lightReviews: number;
  intermediateReviews: number;
  complexReviewsNeeded: number;
  maintainerDecisions: number;
  readyForMaintainer: number;

  // Review call avoidance estimate (only verified closure candidates)
  estimatedReviewCallsAvoided: number;
  reviewCallAvoidanceNote: string; // disclaimer: not based on unverified assumptions

  // Separate PR and issue counts
  byItemType: {
    pr: Record<TriageActionGroup, number>;
    issue: Record<TriageActionGroup, number>;
  };
}

export interface TriagePlan {
  schemaVersion: string;
  generatedAt: string;
  repo: string;
  summary: TriagePlanSummary;
  // Priority-ordered entries
  entries: TriagePlanEntry[];
  // Stable contract version for review scheduler
  schedulerContractVersion: string;
}

export interface TriagePlanInputEntry {
  item: PRItem;
  actionSignal: string;
  actionReasons: string[];
  calibratedBand: string;
  closureCandidateVerified?: boolean;
  closureCandidateEvidenceNote?: string;
}

/**
 * Map a ResolutionActionSignal or advisory route to a TriageActionGroup.
 */
export function mapToTriageActionGroup(actionSignal: string, _closureCandidateVerified?: boolean): TriageActionGroup {
  if (!actionSignal || typeof actionSignal !== "string") {
    return "READY_FOR_MAINTAINER";
  }

  const signal = actionSignal.trim();

  switch (signal) {
    case "CLOSE_CANDIDATE":
    case "CLOSURE_CANDIDATES":
    case "close_candidate":
    case "closure_candidates":
      return "CLOSURE_CANDIDATES";

    case "REQUEST_INFORMATION":
    case "INFORMATION_REQUESTS":
    case "request_information":
    case "information_requests":
    case "needs_reproduction":
      return "INFORMATION_REQUESTS";

    case "LIGHT_REVIEW":
    case "light_review":
    case "routine_review":
    case "documentation_only":
      return "LIGHT_REVIEW";

    case "INTERMEDIATE_REVIEW":
    case "intermediate_review":
      return "INTERMEDIATE_REVIEW";

    case "COMPLEX_REVIEW_NEEDED":
    case "complex_review_needed":
    case "expert_investigation":
      return "COMPLEX_REVIEW_NEEDED";

    case "MAINTAINER_DECISION":
    case "maintainer_decision":
    case "security_escalation":
      return "MAINTAINER_DECISION";

    case "READY_FOR_MAINTAINER":
    case "ready_for_maintainer":
    case "maintainer_triage":
      return "READY_FOR_MAINTAINER";

    default:
      return "READY_FOR_MAINTAINER";
  }
}

function parseBandRank(band: string): number {
  const b = (band || "").trim().toUpperCase();
  if (b.startsWith("P0")) return 0;
  if (b.startsWith("P1")) return 1;
  if (b.startsWith("P2")) return 2;
  if (b.startsWith("P3")) return 3;
  if (b.startsWith("P4")) return 4;
  if (b.includes("CRITICAL")) return 0;
  if (b.includes("HIGH")) return 1;
  if (b.includes("MODERATE") || b.includes("MEDIUM")) return 2;
  if (b.includes("ROUTINE") || b.includes("LOW")) return 3;
  return 99;
}

function createZeroGroupCounts(): Record<TriageActionGroup, number> {
  return {
    CLOSURE_CANDIDATES: 0,
    INFORMATION_REQUESTS: 0,
    LIGHT_REVIEW: 0,
    INTERMEDIATE_REVIEW: 0,
    COMPLEX_REVIEW_NEEDED: 0,
    MAINTAINER_DECISION: 0,
    READY_FOR_MAINTAINER: 0,
  };
}

/**
 * Build a reproducible triage plan from items and their calibrated data.
 */
export function buildTriagePlan(
  entries: TriagePlanInputEntry[],
  repo: string,
  options?: { generatedAt?: string },
): TriagePlan {
  const generatedAt = options?.generatedAt ?? new Date().toISOString();

  // 1. Map each entry's actionSignal -> TriageActionGroup via mapToTriageActionGroup
  const mapped = entries.map((entry) => {
    const actionGroup = mapToTriageActionGroup(entry.actionSignal, entry.closureCandidateVerified);
    return {
      entry,
      actionGroup,
    };
  });

  // 2. Sort entries by group priority (CLOSURE_CANDIDATES first, READY_FOR_MAINTAINER last),
  // then by calibratedBand (P0 first), then by itemType (pr before issue), then by item number ascending
  mapped.sort((a, b) => {
    // 2a. Group priority
    const groupDiff = GROUP_PRIORITY_MAP[a.actionGroup] - GROUP_PRIORITY_MAP[b.actionGroup];
    if (groupDiff !== 0) return groupDiff;

    // 2b. Calibrated band (P0 first)
    const bandRankA = parseBandRank(a.entry.calibratedBand);
    const bandRankB = parseBandRank(b.entry.calibratedBand);
    if (bandRankA !== bandRankB) return bandRankA - bandRankB;
    const bandAlpha = a.entry.calibratedBand.localeCompare(b.entry.calibratedBand);
    if (bandAlpha !== 0) return bandAlpha;

    // 2c. Item type (pr before issue)
    const typeRankA = a.entry.item.type === "pr" ? 0 : 1;
    const typeRankB = b.entry.item.type === "pr" ? 0 : 1;
    if (typeRankA !== typeRankB) return typeRankA - typeRankB;

    // 2d. Item number ascending
    if (a.entry.item.number !== b.entry.item.number) {
      return a.entry.item.number - b.entry.item.number;
    }

    // Deterministic fallback for identical inputs
    return (a.entry.item.title || "").localeCompare(b.entry.item.title || "");
  });

  // 3. Assign rank (1-indexed, global) & build plan entries
  const planEntries: TriagePlanEntry[] = [];
  const groupCounts: Record<TriageActionGroup, number> = createZeroGroupCounts();
  const byItemType = {
    pr: createZeroGroupCounts(),
    issue: createZeroGroupCounts(),
  };

  let totalPRs = 0;
  let totalIssues = 0;
  let estimatedReviewCallsAvoided = 0;

  for (let i = 0; i < mapped.length; i++) {
    const { entry, actionGroup } = mapped[i];
    const isClosureCandidate = actionGroup === "CLOSURE_CANDIDATES";
    // 4. Set estimatedReviewCallAvoided = true ONLY for CLOSURE_CANDIDATES where closureCandidateVerified === true
    const isVerifiedClosure = isClosureCandidate && entry.closureCandidateVerified === true;
    const estimatedReviewCallAvoided = isVerifiedClosure;

    const reasons = entry.actionReasons ?? (entry as unknown as { actionReason?: string[] }).actionReason ?? [];

    const planEntry: TriagePlanEntry = {
      rank: i + 1,
      actionGroup,
      itemType: entry.item.type,
      repo: entry.item.repo || repo,
      number: entry.item.number,
      title: entry.item.title,
      actionSignal: entry.actionSignal,
      actionReason: Array.isArray(reasons) ? [...reasons] : [],
      estimatedReviewCallAvoided,
      priorityBand: entry.calibratedBand,
      requiresMaintainerApproval: true,
    };

    if (isClosureCandidate) {
      planEntry.closureCandidateVerified = Boolean(entry.closureCandidateVerified);
    }

    // 5. Set evidenceForAvoidance only when estimatedReviewCallAvoided === true (from closureCandidateEvidenceNote)
    if (estimatedReviewCallAvoided && entry.closureCandidateEvidenceNote) {
      planEntry.evidenceForAvoidance = entry.closureCandidateEvidenceNote;
    }

    planEntries.push(planEntry);

    // 6. Compute summary counts
    groupCounts[actionGroup]++;
    if (entry.item.type === "pr") {
      totalPRs++;
      byItemType.pr[actionGroup]++;
    } else {
      totalIssues++;
      byItemType.issue[actionGroup]++;
    }

    if (estimatedReviewCallAvoided) {
      estimatedReviewCallsAvoided++;
    }
  }

  // 7. reviewCallAvoidanceNote disclaimer
  const summary: TriagePlanSummary = {
    schemaVersion: TRIAGE_PLAN_SCHEMA_VERSION,
    generatedAt,
    repo,
    totalItems: planEntries.length,
    totalPRs,
    totalIssues,
    closureCandidates: groupCounts.CLOSURE_CANDIDATES,
    informationRequests: groupCounts.INFORMATION_REQUESTS,
    lightReviews: groupCounts.LIGHT_REVIEW,
    intermediateReviews: groupCounts.INTERMEDIATE_REVIEW,
    complexReviewsNeeded: groupCounts.COMPLEX_REVIEW_NEEDED,
    maintainerDecisions: groupCounts.MAINTAINER_DECISION,
    readyForMaintainer: groupCounts.READY_FOR_MAINTAINER,
    estimatedReviewCallsAvoided,
    reviewCallAvoidanceNote: REVIEW_CALL_AVOIDANCE_NOTE,
    byItemType,
  };

  return {
    schemaVersion: TRIAGE_PLAN_SCHEMA_VERSION,
    generatedAt,
    repo,
    summary,
    entries: planEntries,
    schedulerContractVersion: TRIAGE_SCHEDULER_CONTRACT_VERSION,
  };
}

/**
 * Export plan as formatted JSON (for scheduler consumption).
 */
export function exportTriagePlanJson(plan: TriagePlan): string {
  return JSON.stringify(plan, null, 2);
}
