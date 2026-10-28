import type { PRItem } from "../types.js";

export const CLOSURE_EVIDENCE_SCHEMA_VERSION = "1.0.0";

export type ClosureEvidenceClass =
  | "SUSPECTED_DUPLICATE" // similarity only, no other evidence
  | "STRONGLY_SUPPORTED_DUPLICATE" // similarity + label overlap + matching behavior description
  | "SUPERSEDED_BY_OPEN_ALTERNATIVE" // newer open PR covers the same problem
  | "SUPERSEDED_BY_MERGED_REPLACEMENT" // newer MERGED PR covers the same problem
  | "ISSUE_RESOLVED_BY_MERGED_FIX" // open issue + merged PR with closing reference
  | "UNRESOLVED_INSUFFICIENT_EVIDENCE" // cannot classify confidently
  | "CLOSURE_VERIFIED"; // verifiable evidence proves redundancy/resolution

export interface ClosureCandidateRecord {
  schemaVersion: string;
  sourceItem: {
    repo: string;
    number: number;
    type: "pr" | "issue";
    title: string;
    state: string;
    createdAt: string;
    labels: string[];
  };
  proposedCanonicalItem: {
    repo: string;
    number: number;
    type: "pr" | "issue";
    title: string;
    state: string; // "merged", "closed", "open"
    closedAt?: string;
  };
  relationship: ClosureEvidenceClass;
  githubLinks: {
    sourceUrl: string;
    canonicalUrl: string;
  };
  matchingBehaviorOrRequirements: string[]; // phrases from source/canonical that match
  relevantCommitsOrFiles: string[]; // file paths or commit OIDs if available
  closingEdgeConfirmed: boolean; // explicit GitHub closing keyword or head-oid match
  missingEvidence: string[]; // what would be needed to elevate evidence tier
  jevDecision?: {
    duplicateCandidateNoul?: number;
    alreadyResolvedNoul?: number;
    confidence?: number;
    model?: string;
  };
  deterministicEvidenceChecks: {
    headOidMatch: boolean;
    closingReferencePresent: boolean;
    targetIsMerged: boolean;
    labelOverlap: string[];
    embeddingSimilarity: number | null;
  };
  closureVerified: boolean; // only true when ALL CLOSURE_VERIFIED criteria are met
  requiresManualVerification: boolean; // ALWAYS true — even verified candidates need maintainer approval
  pendingMaintainerApproval: boolean; // ALWAYS true — we never auto-close GitHub
}

export interface BuildClosureCandidateOptions {
  embeddingSimilarity?: number | null;
  closingEdgeConfirmed?: boolean;
  matchingBehaviorPhrases?: string[];
  relevantFiles?: string[];
  jevDecision?: ClosureCandidateRecord["jevDecision"];
  missingEvidence?: string[];
  relationship?: ClosureEvidenceClass;
}

export interface ClosureEvidenceFactors {
  headOidMatch: boolean;
  closingReferencePresent: boolean;
  embeddingSimilarity: number | null;
  labelOverlap: string[];
  jevDuplicateNoul?: number;
  jevAlreadyResolvedNoul?: number;
}

export interface ClosureCandidateExport {
  schemaVersion: string;
  generatedAt: string;
  repo: string;
  totalCandidates: number;
  verifiedCandidates: number;
  pendingManualReview: number;
  byEvidenceClass: Record<ClosureEvidenceClass, number>;
  candidates: ClosureCandidateRecord[];
}

function isOlder(a: PRItem, b: PRItem): boolean {
  const timeA = new Date(a.createdAt).getTime();
  const timeB = new Date(b.createdAt).getTime();
  if (!Number.isNaN(timeA) && !Number.isNaN(timeB)) {
    return timeA < timeB;
  }
  return a.createdAt < b.createdAt;
}

function buildItemUrl(repo: string, type: "pr" | "issue", number: number): string {
  const path = type === "pr" ? "pull" : "issues";
  return `https://github.com/${repo}/${path}/${number}`;
}

function isReopenedDefect(sourceItem: PRItem): boolean {
  if (sourceItem.type !== "issue") return false;
  const hasReopenedLabel = sourceItem.labels.some((l) => /re-?open/i.test(l));
  const openWithClosedAt = sourceItem.state.toLowerCase() === "open" && Boolean(sourceItem.closedAt);
  return hasReopenedLabel || openWithClosedAt;
}

/**
 * Classify evidence tier deterministically (no Jev calls).
 * Follows the 7-step evidence priority algorithm:
 * 1. headOidMatch === true -> STRONGLY_SUPPORTED_DUPLICATE
 * 2. closingReferencePresent === true && canonical state is "merged" && source is issue -> ISSUE_RESOLVED_BY_MERGED_FIX
 * 3. closingReferencePresent === true && canonical state is "merged" && source is PR -> SUPERSEDED_BY_MERGED_REPLACEMENT
 * 4. closingReferencePresent === false && canonical state is "open" && sim >= 0.85 && jevDuplicateNoul >= 0.8 -> STRONGLY_SUPPORTED_DUPLICATE
 * 5. embeddingSimilarity >= 0.72 && (labelOverlap >= 1 || jevDuplicateNoul >= 0.6) -> SUSPECTED_DUPLICATE
 * 6. canonical state is "open" && source is older (only if sim >= 0.85) -> SUPERSEDED_BY_OPEN_ALTERNATIVE
 * 7. Default -> UNRESOLVED_INSUFFICIENT_EVIDENCE
 */
export function classifyClosureEvidence(
  sourceItem: PRItem,
  canonicalItem: PRItem,
  factors: ClosureEvidenceFactors,
): ClosureEvidenceClass {
  const canonicalState = canonicalItem.state.toLowerCase();

  // 1. headOidMatch === true -> IDENTITY_DUPLICATE (map to STRONGLY_SUPPORTED_DUPLICATE)
  if (factors.headOidMatch) {
    return "STRONGLY_SUPPORTED_DUPLICATE";
  }

  // 2. closingReferencePresent === true AND canonical state is "merged" AND source is an issue -> ISSUE_RESOLVED_BY_MERGED_FIX
  if (factors.closingReferencePresent && canonicalState === "merged" && sourceItem.type === "issue") {
    return "ISSUE_RESOLVED_BY_MERGED_FIX";
  }

  // 3. closingReferencePresent === true AND canonical state is "merged" AND source is a PR -> SUPERSEDED_BY_MERGED_REPLACEMENT
  if (factors.closingReferencePresent && canonicalState === "merged" && sourceItem.type === "pr") {
    return "SUPERSEDED_BY_MERGED_REPLACEMENT";
  }

  // 4. closingReferencePresent === false AND canonical state is "open" AND embeddingSimilarity >= 0.85 AND jevDuplicateNoul >= 0.8 -> STRONGLY_SUPPORTED_DUPLICATE
  if (
    !factors.closingReferencePresent &&
    canonicalState === "open" &&
    (factors.embeddingSimilarity ?? 0) >= 0.85 &&
    (factors.jevDuplicateNoul ?? 0) >= 0.8
  ) {
    return "STRONGLY_SUPPORTED_DUPLICATE";
  }

  // 5. embeddingSimilarity >= 0.72 AND (labelOverlap.length >= 1 OR jevDuplicateNoul >= 0.6) -> SUSPECTED_DUPLICATE
  if (
    (factors.embeddingSimilarity ?? 0) >= 0.72 &&
    (factors.labelOverlap.length >= 1 || (factors.jevDuplicateNoul ?? 0) >= 0.6)
  ) {
    return "SUSPECTED_DUPLICATE";
  }

  // 6. canonical state is "open" AND source is older -> SUPERSEDED_BY_OPEN_ALTERNATIVE (only if sim >= 0.85)
  if (canonicalState === "open" && isOlder(sourceItem, canonicalItem) && (factors.embeddingSimilarity ?? 0) >= 0.85) {
    return "SUPERSEDED_BY_OPEN_ALTERNATIVE";
  }

  // 7. Default -> UNRESOLVED_INSUFFICIENT_EVIDENCE
  return "UNRESOLVED_INSUFFICIENT_EVIDENCE";
}

/**
 * Build a closure candidate record from two items.
 * Performs deterministic evidence checks, populates missing evidence, and verifies closure criteria.
 */
export function buildClosureCandidateRecord(
  sourceItem: PRItem,
  canonicalItem: PRItem,
  options: BuildClosureCandidateOptions = {},
): ClosureCandidateRecord {
  const headOidMatch = Boolean(
    sourceItem.headRefOid && canonicalItem.headRefOid && sourceItem.headRefOid === canonicalItem.headRefOid,
  );

  const detectedClosingRef = Boolean(
    canonicalItem.closesIssues?.includes(sourceItem.number) || sourceItem.closesIssues?.includes(canonicalItem.number),
  );

  const closingReferencePresent =
    options.closingEdgeConfirmed !== undefined ? options.closingEdgeConfirmed && !headOidMatch : detectedClosingRef;

  const closingEdgeConfirmed = options.closingEdgeConfirmed ?? (headOidMatch || detectedClosingRef);

  const embeddingSimilarity = options.embeddingSimilarity ?? null;

  const labelOverlap = sourceItem.labels.filter((label) => canonicalItem.labels.includes(label));

  const targetIsMerged = canonicalItem.state.toLowerCase() === "merged";
  const targetIsClosed = canonicalItem.state.toLowerCase() === "closed";

  const relationship =
    options.relationship ??
    classifyClosureEvidence(sourceItem, canonicalItem, {
      headOidMatch,
      closingReferencePresent,
      embeddingSimilarity,
      labelOverlap,
      jevDuplicateNoul: options.jevDecision?.duplicateCandidateNoul,
      jevAlreadyResolvedNoul: options.jevDecision?.alreadyResolvedNoul,
    });

  const matchingBehaviorOrRequirements = [...(options.matchingBehaviorPhrases ?? [])];

  const relevantCommitsOrFiles = [...(options.relevantFiles ?? [])];
  if (headOidMatch && sourceItem.headRefOid && !relevantCommitsOrFiles.includes(sourceItem.headRefOid)) {
    relevantCommitsOrFiles.push(sourceItem.headRefOid);
  }

  const missingEvidence: string[] = [];

  // Check 1: relationship eligibility
  const eligibleClasses: ClosureEvidenceClass[] = [
    "ISSUE_RESOLVED_BY_MERGED_FIX",
    "SUPERSEDED_BY_MERGED_REPLACEMENT",
    "STRONGLY_SUPPORTED_DUPLICATE",
  ];
  if (!eligibleClasses.includes(relationship)) {
    missingEvidence.push(`Evidence class '${relationship}' does not meet minimum closure verification tier`);
  }

  // Check 2: closing edge confirmation
  if (!closingEdgeConfirmed) {
    missingEvidence.push("Explicit closing keyword reference or identical head commit OID is required");
  }

  // Check 3: target state
  if (!targetIsMerged && !targetIsClosed) {
    missingEvidence.push(`Proposed canonical item must be merged or closed (current state: ${canonicalItem.state})`);
  }

  // Check 4: Jev decision confidence (unless deterministic head OID match)
  const dupNoul = options.jevDecision?.duplicateCandidateNoul ?? 0;
  const resNoul = options.jevDecision?.alreadyResolvedNoul ?? 0;
  if (!headOidMatch && dupNoul < 0.8 && resNoul < 0.8) {
    missingEvidence.push("Jev decision duplicate or resolved confidence score (noul) must be >= 0.80");
  }

  // Check 5: Reopened defect check
  if (isReopenedDefect(sourceItem)) {
    missingEvidence.push(
      "Source issue was reopened after canonical fix — defect may have regressed or fix was incomplete",
    );
  }

  // Check 6: Caller-specified missing evidence
  if (options.missingEvidence && options.missingEvidence.length > 0) {
    missingEvidence.push(...options.missingEvidence);
  }

  // CLOSURE_VERIFIED criteria (ALL must be true):
  // - evidenceClass is ISSUE_RESOLVED_BY_MERGED_FIX, SUPERSEDED_BY_MERGED_REPLACEMENT, or STRONGLY_SUPPORTED_DUPLICATE
  // - closingEdgeConfirmed: true (explicit closesIssues reference or identical head-oid)
  // - targetState is "merged" or "closed" (for duplicates: target is the canonical)
  // - Jev decision (if available) has duplicate/resolved noul >= 0.8 (or headOidMatch for identity)
  // - missingEvidence array is empty
  const closureVerified =
    eligibleClasses.includes(relationship) &&
    closingEdgeConfirmed &&
    (targetIsMerged || targetIsClosed) &&
    (dupNoul >= 0.8 || resNoul >= 0.8 || headOidMatch) &&
    missingEvidence.length === 0;

  return {
    schemaVersion: CLOSURE_EVIDENCE_SCHEMA_VERSION,
    sourceItem: {
      repo: sourceItem.repo,
      number: sourceItem.number,
      type: sourceItem.type,
      title: sourceItem.title,
      state: sourceItem.state,
      createdAt: sourceItem.createdAt,
      labels: [...sourceItem.labels],
    },
    proposedCanonicalItem: {
      repo: canonicalItem.repo,
      number: canonicalItem.number,
      type: canonicalItem.type,
      title: canonicalItem.title,
      state: canonicalItem.state,
      ...(canonicalItem.closedAt ? { closedAt: canonicalItem.closedAt } : {}),
    },
    relationship,
    githubLinks: {
      sourceUrl: buildItemUrl(sourceItem.repo, sourceItem.type, sourceItem.number),
      canonicalUrl: buildItemUrl(canonicalItem.repo, canonicalItem.type, canonicalItem.number),
    },
    matchingBehaviorOrRequirements,
    relevantCommitsOrFiles,
    closingEdgeConfirmed,
    missingEvidence,
    ...(options.jevDecision ? { jevDecision: options.jevDecision } : {}),
    deterministicEvidenceChecks: {
      headOidMatch,
      closingReferencePresent,
      targetIsMerged,
      labelOverlap,
      embeddingSimilarity,
    },
    closureVerified,
    requiresManualVerification: true,
    pendingMaintainerApproval: true,
  };
}

/**
 * Export all closure candidates as a JSON-serializable object.
 */
export function exportClosureCandidates(candidates: ClosureCandidateRecord[], repo: string): ClosureCandidateExport {
  const byEvidenceClass: Record<ClosureEvidenceClass, number> = {
    SUSPECTED_DUPLICATE: 0,
    STRONGLY_SUPPORTED_DUPLICATE: 0,
    SUPERSEDED_BY_OPEN_ALTERNATIVE: 0,
    SUPERSEDED_BY_MERGED_REPLACEMENT: 0,
    ISSUE_RESOLVED_BY_MERGED_FIX: 0,
    UNRESOLVED_INSUFFICIENT_EVIDENCE: 0,
    CLOSURE_VERIFIED: 0,
  };

  let verifiedCount = 0;
  for (const candidate of candidates) {
    if (candidate.closureVerified) {
      verifiedCount++;
    }
    if (candidate.relationship in byEvidenceClass) {
      byEvidenceClass[candidate.relationship]++;
    }
  }

  return {
    schemaVersion: CLOSURE_EVIDENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repo,
    totalCandidates: candidates.length,
    verifiedCandidates: verifiedCount,
    pendingManualReview: candidates.filter((c) => c.requiresManualVerification).length,
    byEvidenceClass,
    candidates: [...candidates],
  };
}
