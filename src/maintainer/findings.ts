/**
 * Maintainer Findings Formatter (Task C - AGY-03)
 *
 * Formats pull request and issue triage & review results for maintainers,
 * clearly demarcating source-backed verified facts from advisory model predictions.
 *
 * Invariant Guarantees:
 * - Model findings are never presented as proven defects (disclaimer attached to all findings).
 * - Embedding cluster similarity is labeled as candidate signal only, unless confirmed by
 *   identical head commit or patch-id.
 * - Source-backed facts (state, author, labels, commit SHA) are cleanly separated from
 *   advisory model recommendations (Jev triage, LLM code review).
 */

import type { JevFirstDecisionRecord } from "../decisions/triage-v2.js";
import type { PRItem } from "../types.js";

export interface ModelFinding {
  severity: string;
  category: string;
  fileOrSymbol: string | null;
  description: string;
  groundedEvidence: string | null;
  /** Always "NOTE: Model finding — not independently verified." */
  disclaimer: string;
}

export interface DuplicateEvidence {
  clusterId: number;
  clusterSize: number;
  isConfirmed: boolean; // identity duplicate (head-oid)
  confidence: string; // "high"|"solid"|"loose"
  minSimilarity: number;
  relatedNumbers: number[];
  /** Always: "embedding-similarity is not a confirmed defect" for fuzzy clusters */
  note: string;
}

export interface PrFinding {
  url: string;
  state: string;
  title: string;
  summary: string;
  // Jev classification (labeled advisory)
  jevCategory: string | null;
  jevUrgency: string | null;
  jevRisk: { security: boolean; breakingChange: boolean; dataLoss: boolean } | null;
  // Cluster evidence (source-backed)
  duplicateEvidence: DuplicateEvidence | null;
  // Review tier
  reviewTier: string | null;
  reviewState: "complete" | "incomplete" | "none";
  reviewRecommendation?: string | null;
  // Deep review model findings (clearly labeled as model output)
  modelFindings: ModelFinding[];
  modelUncertainties: string[];
  reviewConfidence: number | null;
  // Suggested next action
  suggestedAction: string;
  humanReviewStillNeeded: boolean;
  // Source labeling
  sourceBackedFacts: string[];
  modelRecommendations: string[];
}

export interface IssueFinding {
  url: string;
  state: string;
  title: string;
  summary: string;
  // Jev
  jevCategory: string | null;
  jevUrgency: string | null;
  missingEvidence: string[];
  suggestedNextSteps: string[];
  // Reproduction / impact
  reproductionAssessment: string | null;
  validityAssessment: string | null;
  issueAction: string | null;
  // Model findings clearly labeled
  modelUncertainties: string[];
  reviewConfidence: number | null;
  suggestedAction: string;
  humanReviewStillNeeded: boolean;
  sourceBackedFacts: string[];
  modelRecommendations: string[];
}

export interface ClusterMembershipInfo {
  clusterId: number;
  clusterSize: number;
  isConfirmedDuplicate: boolean;
  minSimilarity: number;
  confidence: "high" | "solid" | "loose";
  relatedNumbers: number[];
}

export interface FormatPrFindingOptions {
  jevRecord?: JevFirstDecisionRecord;
  rawReview?: unknown; // parsed deep-review JSON from store
  clusterMembership?: ClusterMembershipInfo;
  reviewTier?: string;
}

export interface FormatIssueFindingOptions {
  jevRecord?: JevFirstDecisionRecord;
  rawReview?: unknown;
  clusterMembership?: ClusterMembershipInfo;
}

/** Safely parse unknown review payload into an object or null */
function parseRawReview(raw: unknown): Record<string, any> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, any>;
  }
  return null;
}

/**
 * Format a Pull Request item and its advisory triage/review outputs
 * for maintainer evaluation with strict provenance labeling.
 */
export function formatPrFinding(item: PRItem, opts: FormatPrFindingOptions = {}): PrFinding {
  const url = (item as any).url || `https://github.com/${item.repo}/pull/${item.number}`;

  const parsedReview = parseRawReview(opts.rawReview);

  // Review state determination
  let reviewState: "complete" | "incomplete" | "none" = "none";
  if (opts.rawReview !== undefined && opts.rawReview !== null) {
    if (!parsedReview) {
      reviewState = "incomplete";
    } else if (
      typeof parsedReview.summary === "string" &&
      parsedReview.summary.trim() &&
      typeof parsedReview.recommendation === "string" &&
      parsedReview.recommendation.trim() &&
      parsedReview.status !== "incomplete" &&
      parsedReview.status !== "failed"
    ) {
      reviewState = "complete";
    } else {
      reviewState = "incomplete";
    }
  }

  // Summary resolution
  let summary = "";
  if (typeof parsedReview?.summary === "string" && parsedReview.summary.trim()) {
    summary = parsedReview.summary.trim();
  } else if (item.body?.trim()) {
    summary = item.body.trim().slice(0, 300);
  } else {
    summary = item.title;
  }

  // Jev triage extraction
  const jevRecord = opts.jevRecord;
  const jevCategory = jevRecord?.classification?.category ?? null;
  const jevUrgency = jevRecord?.derived?.priorityTier ?? null;

  let jevRisk: { security: boolean; breakingChange: boolean; dataLoss: boolean } | null = null;
  if (jevRecord) {
    const riskFlags = jevRecord.derived?.riskFlags || [];
    const safetyGates = jevRecord.routing?.deterministicSafetyGates || [];
    const scores = jevRecord.scores || {};
    jevRisk = {
      security:
        riskFlags.includes("security") ||
        safetyGates.some((g) => g.toLowerCase().includes("security")) ||
        ((scores as any).securityRiskProb ?? scores.securityVulnerabilityProb ?? 0) >= 0.5,
      breakingChange:
        riskFlags.includes("breaking_change") ||
        safetyGates.some((g) => g.toLowerCase().includes("breaking")) ||
        ((scores as any).breakingRiskProb ?? scores.breakingChangeProb ?? 0) >= 0.5,
      dataLoss:
        riskFlags.includes("data_loss") ||
        safetyGates.some((g) => g.toLowerCase().includes("data_loss") || g.toLowerCase().includes("data-loss")) ||
        ((scores as any).dataLossRiskProb ?? scores.dataLossOrCorruptionProb ?? 0) >= 0.5,
    };
  }

  // Duplicate / cluster evidence
  let duplicateEvidence: DuplicateEvidence | null = null;
  if (opts.clusterMembership) {
    const cm = opts.clusterMembership;
    const isConfirmed = Boolean(cm.isConfirmedDuplicate);
    duplicateEvidence = {
      clusterId: cm.clusterId,
      clusterSize: cm.clusterSize,
      isConfirmed,
      confidence: cm.confidence,
      minSimilarity: cm.minSimilarity,
      relatedNumbers: Array.isArray(cm.relatedNumbers) ? [...cm.relatedNumbers] : [],
      note: isConfirmed
        ? "Confirmed: identical head commit or patch-id."
        : "Embedding similarity is a candidate signal only — not a confirmed duplicate without human verification.",
    };
  }

  // Review tier
  const reviewTier = opts.reviewTier ?? jevRecord?.derived?.priorityTier ?? null;

  // Model findings with explicit disclaimer
  const modelFindings: ModelFinding[] = [];
  if (Array.isArray(parsedReview?.findings)) {
    for (const f of parsedReview.findings) {
      if (f && typeof f === "object") {
        modelFindings.push({
          severity: typeof f.severity === "string" ? f.severity : "medium",
          category: typeof f.category === "string" ? f.category : "maintainability",
          fileOrSymbol: typeof f.fileOrSymbol === "string" ? f.fileOrSymbol : null,
          description: typeof f.description === "string" ? f.description : "",
          groundedEvidence: typeof f.groundedEvidence === "string" ? f.groundedEvidence : null,
          disclaimer: "NOTE: Model finding — not independently verified.",
        });
      }
    }
  }

  // Model uncertainties
  const modelUncertainties: string[] = [];
  if (Array.isArray(parsedReview?.modelUncertainties)) {
    for (const u of parsedReview.modelUncertainties) {
      if (typeof u === "string" && u.trim() && !modelUncertainties.includes(u.trim())) {
        modelUncertainties.push(u.trim());
      }
    }
  }
  if (Array.isArray(parsedReview?.concerns)) {
    for (const c of parsedReview.concerns) {
      if (typeof c === "string" && c.trim() && !modelUncertainties.includes(c.trim())) {
        modelUncertainties.push(c.trim());
      }
    }
  }
  if (jevRecord?.routing?.uncertaintyFlags) {
    for (const flag of jevRecord.routing.uncertaintyFlags) {
      if (typeof flag === "string" && flag.trim() && !modelUncertainties.includes(flag.trim())) {
        modelUncertainties.push(flag.trim());
      }
    }
  }

  // Review confidence
  let reviewConfidence: number | null = null;
  if (typeof parsedReview?.confidence === "number") {
    reviewConfidence = parsedReview.confidence;
  } else if (typeof jevRecord?.classification?.categoryConfidence === "number") {
    reviewConfidence = jevRecord.classification.categoryConfidence;
  }

  // Suggested next action
  let suggestedAction: string;
  if (duplicateEvidence?.isConfirmed) {
    suggestedAction = `Close as confirmed duplicate of #${duplicateEvidence.relatedNumbers.join(", #")}`;
  } else if (typeof parsedReview?.recommendation === "string" && parsedReview.recommendation.trim()) {
    suggestedAction = parsedReview.recommendation.trim();
  } else if (jevRecord?.routing?.advisoryRoute) {
    suggestedAction = jevRecord.routing.advisoryRoute;
  } else if (duplicateEvidence) {
    suggestedAction = `Investigate similarity cluster #${duplicateEvidence.clusterId}`;
  } else {
    suggestedAction = item.state === "open" ? "Needs human review" : "No action needed";
  }

  // Maintainer review gate
  const humanReviewStillNeeded =
    typeof parsedReview?.humanReviewStillNeeded === "boolean"
      ? parsedReview.humanReviewStillNeeded
      : item.state === "open" || reviewState !== "complete";

  // Source-backed facts (GitHub API / DB)
  const sourceBackedFacts: string[] = [
    `State: ${item.state}`,
    `Author: @${item.author}${item.authorIsBot ? " [bot]" : ""}`,
    `Created: ${item.createdAt}`,
    `Updated: ${item.updatedAt}`,
    `Labels: ${item.labels && item.labels.length > 0 ? item.labels.join(", ") : "none"}`,
  ];
  if (item.closedAt) {
    sourceBackedFacts.push(`Closed: ${item.closedAt}`);
  }
  if (item.diffUrl) {
    sourceBackedFacts.push(`Diff URL: ${item.diffUrl}`);
  }
  if (item.ciStatus) {
    sourceBackedFacts.push(`CI Status: ${item.ciStatus}`);
  }
  if (typeof item.changedFiles === "number") {
    sourceBackedFacts.push(`Changes: ${item.changedFiles} files (+${item.additions ?? 0}/-${item.deletions ?? 0})`);
  }
  if (typeof item.hasTests === "boolean") {
    sourceBackedFacts.push(`Tests present: ${item.hasTests ? "yes" : "no"}`);
  }
  if (item.headRefOid) {
    sourceBackedFacts.push(`Head OID: ${item.headRefOid}`);
  }
  if (item.closesIssues && item.closesIssues.length > 0) {
    sourceBackedFacts.push(`Closes issues: ${item.closesIssues.map((n) => `#${n}`).join(", ")}`);
  }
  if (duplicateEvidence?.isConfirmed) {
    sourceBackedFacts.push(
      `Identity match: identical commit/patch with #${duplicateEvidence.relatedNumbers.join(", #")}`,
    );
  }

  // Model recommendations (Jev and LLM)
  const modelRecommendations: string[] = [];
  if (jevRecord) {
    if (jevRecord.classification?.category) {
      modelRecommendations.push(`Jev category (advisory): ${jevRecord.classification.category}`);
    }
    if (jevRecord.derived?.priorityTier) {
      modelRecommendations.push(`Jev priority tier: ${jevRecord.derived.priorityTier}`);
    }
    if (jevRecord.derived?.complexityTier) {
      modelRecommendations.push(`Jev complexity: ${jevRecord.derived.complexityTier}`);
    }
    if (jevRecord.routing?.advisoryRoute) {
      modelRecommendations.push(`Jev routing route: ${jevRecord.routing.advisoryRoute}`);
    }
    if (
      jevRecord.derived?.riskFlags &&
      jevRecord.derived.riskFlags.length > 0 &&
      !jevRecord.derived.riskFlags.includes("none")
    ) {
      modelRecommendations.push(`Jev risk flags: ${jevRecord.derived.riskFlags.join(", ")}`);
    }
    if (jevRecord.routing?.escalateToDeepReview) {
      modelRecommendations.push(
        `Jev escalation: deep review recommended (${jevRecord.routing.escalationReasons?.join(", ") || "risk triggers"})`,
      );
    }
  }
  if (parsedReview) {
    if (typeof parsedReview.recommendation === "string") {
      modelRecommendations.push(`Review recommendation: ${parsedReview.recommendation}`);
    }
    if (typeof parsedReview.confidence === "number") {
      modelRecommendations.push(`Review confidence: ${(parsedReview.confidence * 100).toFixed(0)}%`);
    }
    if (modelFindings.length > 0) {
      modelRecommendations.push(`Model findings: ${modelFindings.length} issue(s) identified`);
    }
  }
  if (duplicateEvidence && !duplicateEvidence.isConfirmed) {
    modelRecommendations.push(
      `Cluster candidate #${duplicateEvidence.clusterId}: similarity ${(duplicateEvidence.minSimilarity * 100).toFixed(1)}% with #${duplicateEvidence.relatedNumbers.join(", #")} (${duplicateEvidence.confidence} confidence)`,
    );
  }

  return {
    url,
    state: item.state,
    title: item.title,
    summary,
    jevCategory,
    jevUrgency,
    jevRisk,
    duplicateEvidence,
    reviewTier,
    reviewState,
    reviewRecommendation: parsedReview?.recommendation ?? null,
    modelFindings,
    modelUncertainties,
    reviewConfidence,
    suggestedAction,
    humanReviewStillNeeded,
    sourceBackedFacts,
    modelRecommendations,
  };
}

/**
 * Format an Issue item and its advisory triage/review outputs
 * for maintainer evaluation with strict provenance labeling.
 */
export function formatIssueFinding(item: PRItem, opts: FormatIssueFindingOptions = {}): IssueFinding {
  const url = (item as any).url || `https://github.com/${item.repo}/issues/${item.number}`;

  const parsedReview = parseRawReview(opts.rawReview);

  // Summary resolution
  let summary = "";
  if (typeof parsedReview?.summary === "string" && parsedReview.summary.trim()) {
    summary = parsedReview.summary.trim();
  } else if (item.body?.trim()) {
    summary = item.body.trim().slice(0, 300);
  } else {
    summary = item.title;
  }

  // Jev triage extraction
  const jevRecord = opts.jevRecord;
  const jevCategory = jevRecord?.classification?.category ?? null;
  const jevUrgency = jevRecord?.derived?.priorityTier ?? null;

  // Missing evidence and suggested next steps
  const missingEvidence: string[] = [];
  if (Array.isArray(parsedReview?.missingEvidence)) {
    for (const m of parsedReview.missingEvidence) {
      if (typeof m === "string" && m.trim()) {
        missingEvidence.push(m.trim());
      }
    }
  }

  const suggestedNextSteps: string[] = [];
  if (Array.isArray(parsedReview?.suggestedNextSteps)) {
    for (const s of parsedReview.suggestedNextSteps) {
      if (typeof s === "string" && s.trim()) {
        suggestedNextSteps.push(s.trim());
      }
    }
  }

  // Reproduction & validity assessments
  let reproductionAssessment: string | null = null;
  if (typeof parsedReview?.reproductionAssessment === "string" && parsedReview.reproductionAssessment.trim()) {
    reproductionAssessment = parsedReview.reproductionAssessment.trim();
  } else if (
    typeof parsedReview?.rootCauseOrDesignAnalysis === "string" &&
    parsedReview.rootCauseOrDesignAnalysis.trim()
  ) {
    reproductionAssessment = parsedReview.rootCauseOrDesignAnalysis.trim();
  }

  const validityAssessment =
    typeof parsedReview?.validityAssessment === "string" && parsedReview.validityAssessment.trim()
      ? parsedReview.validityAssessment.trim()
      : null;

  const issueAction =
    typeof parsedReview?.issueAction === "string" && parsedReview.issueAction.trim()
      ? parsedReview.issueAction.trim()
      : null;

  // Model uncertainties
  const modelUncertainties: string[] = [];
  if (Array.isArray(parsedReview?.modelUncertainties)) {
    for (const u of parsedReview.modelUncertainties) {
      if (typeof u === "string" && u.trim() && !modelUncertainties.includes(u.trim())) {
        modelUncertainties.push(u.trim());
      }
    }
  }
  if (Array.isArray(parsedReview?.concerns)) {
    for (const c of parsedReview.concerns) {
      if (typeof c === "string" && c.trim() && !modelUncertainties.includes(c.trim())) {
        modelUncertainties.push(c.trim());
      }
    }
  }
  if (jevRecord?.routing?.uncertaintyFlags) {
    for (const flag of jevRecord.routing.uncertaintyFlags) {
      if (typeof flag === "string" && flag.trim() && !modelUncertainties.includes(flag.trim())) {
        modelUncertainties.push(flag.trim());
      }
    }
  }

  // Review confidence
  let reviewConfidence: number | null = null;
  if (typeof parsedReview?.confidence === "number") {
    reviewConfidence = parsedReview.confidence;
  } else if (typeof jevRecord?.classification?.categoryConfidence === "number") {
    reviewConfidence = jevRecord.classification.categoryConfidence;
  }

  // Cluster evidence
  let duplicateEvidence: DuplicateEvidence | null = null;
  if (opts.clusterMembership) {
    const cm = opts.clusterMembership;
    const isConfirmed = Boolean(cm.isConfirmedDuplicate);
    duplicateEvidence = {
      clusterId: cm.clusterId,
      clusterSize: cm.clusterSize,
      isConfirmed,
      confidence: cm.confidence,
      minSimilarity: cm.minSimilarity,
      relatedNumbers: Array.isArray(cm.relatedNumbers) ? [...cm.relatedNumbers] : [],
      note: isConfirmed
        ? "Confirmed: identical head commit or patch-id."
        : "Embedding similarity is a candidate signal only — not a confirmed duplicate without human verification.",
    };
  }

  // Suggested next action
  let suggestedAction: string;
  if (issueAction) {
    suggestedAction = issueAction;
  } else if (jevRecord?.routing?.advisoryRoute) {
    suggestedAction = jevRecord.routing.advisoryRoute;
  } else if (duplicateEvidence?.isConfirmed) {
    suggestedAction = `Close as confirmed duplicate of #${duplicateEvidence.relatedNumbers.join(", #")}`;
  } else if (duplicateEvidence) {
    suggestedAction = `Investigate duplicate cluster #${duplicateEvidence.clusterId}`;
  } else {
    suggestedAction = item.state === "open" ? "Triage issue" : "No action needed";
  }

  // Maintainer review gate
  const humanReviewStillNeeded =
    typeof parsedReview?.humanReviewStillNeeded === "boolean"
      ? parsedReview.humanReviewStillNeeded
      : item.state === "open";

  // Source-backed facts
  const sourceBackedFacts: string[] = [
    `State: ${item.state}`,
    `Author: @${item.author}${item.authorIsBot ? " [bot]" : ""}`,
    `Created: ${item.createdAt}`,
    `Updated: ${item.updatedAt}`,
    `Labels: ${item.labels && item.labels.length > 0 ? item.labels.join(", ") : "none"}`,
  ];
  if (item.closedAt) {
    sourceBackedFacts.push(`Closed: ${item.closedAt}`);
  }

  // Model recommendations
  const modelRecommendations: string[] = [];
  if (jevRecord) {
    if (jevRecord.classification?.category) {
      modelRecommendations.push(`Jev category (advisory): ${jevRecord.classification.category}`);
    }
    if (jevRecord.derived?.priorityTier) {
      modelRecommendations.push(`Jev priority tier: ${jevRecord.derived.priorityTier}`);
    }
    if (jevRecord.derived?.complexityTier) {
      modelRecommendations.push(`Jev complexity: ${jevRecord.derived.complexityTier}`);
    }
    if (jevRecord.routing?.advisoryRoute) {
      modelRecommendations.push(`Jev routing route: ${jevRecord.routing.advisoryRoute}`);
    }
    if (
      jevRecord.derived?.riskFlags &&
      jevRecord.derived.riskFlags.length > 0 &&
      !jevRecord.derived.riskFlags.includes("none")
    ) {
      modelRecommendations.push(`Jev risk flags: ${jevRecord.derived.riskFlags.join(", ")}`);
    }
  }
  if (parsedReview) {
    if (issueAction) {
      modelRecommendations.push(`Suggested issue action: ${issueAction}`);
    }
    if (validityAssessment) {
      modelRecommendations.push(`Validity assessment: ${validityAssessment}`);
    }
    if (typeof parsedReview.confidence === "number") {
      modelRecommendations.push(`Review confidence: ${(parsedReview.confidence * 100).toFixed(0)}%`);
    }
    if (suggestedNextSteps.length > 0) {
      modelRecommendations.push(`Suggested next steps: ${suggestedNextSteps.join("; ")}`);
    }
  }
  if (duplicateEvidence && !duplicateEvidence.isConfirmed) {
    modelRecommendations.push(
      `Cluster candidate #${duplicateEvidence.clusterId}: similarity ${(duplicateEvidence.minSimilarity * 100).toFixed(1)}% with #${duplicateEvidence.relatedNumbers.join(", #")} (${duplicateEvidence.confidence} confidence)`,
    );
  }

  return {
    url,
    state: item.state,
    title: item.title,
    summary,
    jevCategory,
    jevUrgency,
    missingEvidence,
    suggestedNextSteps,
    reproductionAssessment,
    validityAssessment,
    issueAction,
    modelUncertainties,
    reviewConfidence,
    suggestedAction,
    humanReviewStillNeeded,
    sourceBackedFacts,
    modelRecommendations,
  };
}
