/**
 * Task D — Priority Calibration for PR-Prism v4 Jev Housekeeping
 *
 * Implements a calibrated priority tiering layer on top of existing Jev v2 decisions
 * and GitHub metadata.
 *
 * Key Invariants:
 * - P0 requires real operational or security urgency, verified or high-confidence impact,
 *   and immediate maintainer action needed (not just generic keyword matches or broad risk).
 * - Original Jev v2 decision records and escalation bands are NEVER mutated or overwritten.
 * - Deterministic safety gates (security vulnerability with high confidence, data loss with high urgency)
 *   are non-overridable.
 * - Negative controls suppress false-positive P0 escalations (routine docs/tests, generic keywords, bot noise).
 */

import type { PRItem } from "../types.js";

export const PRIORITY_CALIBRATION_SCHEMA_VERSION = "1.0.0";

// Calibrated P0 requires ALL of these:
// 1. Real operational/security urgency (NOT just risk of making a bad change)
// 2. Verified or high-confidence impact (not generic keyword match)
// 3. Immediate action needed (not "this needs careful review")

export type CalibratedPriorityBand =
  | "P0_OPERATIONAL_CRITICAL" // immediate incident / security exploit in production
  | "P0_SECURITY_CRITICAL" // confirmed security vulnerability, privacy breach
  | "P1_HIGH_REVIEW" // complex/risky but NOT urgent operational incident
  | "P1_INFORMATION_NEEDED" // needs info before any action
  | "P2_INTERMEDIATE_REVIEW" // non-trivial but bounded risk
  | "P3_LIGHT_REVIEW" // routine, low-risk
  | "P3_CLOSURE_CANDIDATE" // likely redundant — candidate for closure
  | "P4_STALE_OR_IRRELEVANT"; // stale, irrelevant, or out of scope

export interface CalibrationDimensions {
  // Impact if the underlying defect is real (0-1 normalized)
  defectImpactIfReal: number;
  // Probability/confidence that defect is real (from Jev noul scores or deterministic evidence)
  defectRealityConfidence: number;
  // Urgency: does this need immediate action right now? (0=no, 1=yes)
  urgency: number;
  // Complexity of the proposed change (0=trivial, 1=complex)
  changeComplexity: number;
  // Need for review (0=auto-acceptable, 1=must review)
  reviewNecessity: number;
  // Severity if a verified finding — only set when evidence is verified
  verifiedFindingSeverity: number | null;

  // Negative controls (prevent false P0 escalation)
  isRoutineDocsOrTests: boolean; // docs/tests with no security implications
  hasOnlyGenericSecurityKeywords: boolean; // body has "security" but no specifics
  isBotOrCiNoise: boolean; // authored by bot, or CI noise
  isMissingDescription: boolean; // no body/description
}

export interface CalibratedPriorityRecord {
  schemaVersion: string;
  repo: string;
  itemNumber: number;
  itemType: "pr" | "issue";
  title: string;

  // Original Jev v2 band (NEVER overwritten)
  originalBand: string;
  originalEscalationReasons: string[];

  // New calibrated band
  calibratedBand: CalibratedPriorityBand;
  calibrationReasons: string[]; // what drove the calibrated band
  suppressedReasons: string[]; // reasons that were suppressed by negative controls

  // Dimensions
  dimensions: CalibrationDimensions;

  // Calibration metadata
  calibratedAt: string;
  wasP0InOriginal: boolean; // was this P0_CRITICAL in the original?
  calibrationSchemaVersion: string;
}

export interface P0CalibrationAnalysis {
  schemaVersion: string;
  generatedAt: string;
  repo: string;

  // Before/after counts
  originalP0Count: number;
  calibratedP0OperationalCount: number;
  calibratedP0SecurityCount: number;
  totalCalibratedP0: number;

  // Items that were P0 but are now calibrated lower
  downgradedFromP0: number;
  // New items promoted to P0 (should be rare)
  upgradedToP0: number;

  // Distribution of calibrated bands
  bandDistribution: Record<CalibratedPriorityBand, number>;

  // Key findings
  findings: string[];

  records: CalibratedPriorityRecord[];
}

export interface JevDecisionInput {
  priorityTier?: string;
  complexityTier?: string;
  escalationReasons?: string[];
  deterministicSafetyGates?: string[];
  riskFlags?: string[];
  scores?: {
    securityVulnerabilityRisk?: { noul?: number };
    privacyOrPiiRisk?: { noul?: number };
    dataLossOrCorruptionRisk?: { noul?: number };
    urgentBlocker?: { noul?: number };
    productionImpact?: { norm?: number };
    // Also accept flat score property names from JevDecomposedScores
    urgentBlockerProb?: number | null;
    securityVulnerabilityProb?: number | null;
    privacyOrPiiProb?: number | null;
    dataLossOrCorruptionProb?: number | null;
    productionImpactNorm?: number | null;
  };
  category?: string;
  // Also accept JevFirstDecisionRecord decomposed layout
  derived?: {
    priorityTier?: string;
    complexityTier?: string;
    riskFlags?: string[];
  };
  classification?: {
    category?: string;
  };
  routing?: {
    escalationReasons?: string[];
    deterministicSafetyGates?: string[];
  };
  verifiedFindingSeverity?: number | null;
}

const GENERIC_SECURITY_KEYWORDS_REGEX = /\b(security|auth|authenticat\w*|authoriz\w*)\b/i;
const URGENT_LABEL_REGEX = /\b(urgent|critical)\b/i;

/**
 * Compute calibration dimensions from existing Jev decision + item metadata.
 * Pure and deterministic: does not invoke external providers or make network calls.
 */
export function computeCalibrationDimensions(item: PRItem, jevDecision?: JevDecisionInput): CalibrationDimensions {
  const scores = jevDecision?.scores;

  // 1. defectImpactIfReal: from productionImpact.norm, or 0.5 if unknown
  const prodNorm = scores?.productionImpact?.norm ?? scores?.productionImpactNorm ?? null;
  const defectImpactIfReal = typeof prodNorm === "number" && Number.isFinite(prodNorm) ? prodNorm : 0.5;

  // 2. defectRealityConfidence: from urgentBlocker noul + security noul max, or 0.3 if unknown
  const ubNoul = scores?.urgentBlocker?.noul ?? scores?.urgentBlockerProb ?? null;
  const secNoul = scores?.securityVulnerabilityRisk?.noul ?? scores?.securityVulnerabilityProb ?? null;

  let defectRealityConfidence = 0.3;
  if (
    typeof ubNoul === "number" &&
    Number.isFinite(ubNoul) &&
    typeof secNoul === "number" &&
    Number.isFinite(secNoul)
  ) {
    defectRealityConfidence = Math.max(ubNoul, secNoul);
  } else if (typeof ubNoul === "number" && Number.isFinite(ubNoul)) {
    defectRealityConfidence = ubNoul;
  } else if (typeof secNoul === "number" && Number.isFinite(secNoul)) {
    defectRealityConfidence = secNoul;
  }

  // 3. urgency: from urgentBlocker noul, or label "urgent"/"critical" → 1.0, else 0.2
  const labels = Array.isArray(item.labels) ? item.labels : [];
  const hasUrgentLabel = labels.some((l) => URGENT_LABEL_REGEX.test(l));

  let urgency = 0.2;
  if (hasUrgentLabel) {
    urgency = 1.0;
  } else if (typeof ubNoul === "number" && Number.isFinite(ubNoul)) {
    urgency = ubNoul;
  }

  // 4. changeComplexity: complexityTier mapping (trivial→0, simple→0.2, moderate→0.5, complex→0.9)
  const rawComplexity = (jevDecision?.complexityTier ?? jevDecision?.derived?.complexityTier ?? "").toLowerCase();

  let changeComplexity = 0.5;
  if (rawComplexity === "trivial") {
    changeComplexity = 0.0;
  } else if (rawComplexity === "simple") {
    changeComplexity = 0.2;
  } else if (rawComplexity === "moderate") {
    changeComplexity = 0.5;
  } else if (rawComplexity === "complex") {
    changeComplexity = 0.9;
  }

  // 5. reviewNecessity: from priorityTier (critical→1, high→0.8, medium→0.5, low→0.2)
  const rawPriority = (jevDecision?.priorityTier ?? jevDecision?.derived?.priorityTier ?? "").toLowerCase();

  let reviewNecessity = 0.5;
  if (rawPriority === "critical") {
    reviewNecessity = 1.0;
  } else if (rawPriority === "high") {
    reviewNecessity = 0.8;
  } else if (rawPriority === "medium") {
    reviewNecessity = 0.5;
  } else if (rawPriority === "low") {
    reviewNecessity = 0.2;
  }

  // 6. verifiedFindingSeverity: only set when evidence is verified
  const verifiedFindingSeverity =
    typeof jevDecision?.verifiedFindingSeverity === "number" && Number.isFinite(jevDecision.verifiedFindingSeverity)
      ? jevDecision.verifiedFindingSeverity
      : null;

  // Extract safety gates from jevDecision
  const safetyGates = jevDecision?.deterministicSafetyGates ?? jevDecision?.routing?.deterministicSafetyGates ?? [];

  // 7. isRoutineDocsOrTests: category in ["documentation","tests"] AND no safety gates AND security/privacy/data_loss noul all < 0.3
  const category = (jevDecision?.category ?? jevDecision?.classification?.category ?? "").toLowerCase();

  const privNoul = scores?.privacyOrPiiRisk?.noul ?? scores?.privacyOrPiiProb ?? null;
  const dlNoul = scores?.dataLossOrCorruptionRisk?.noul ?? scores?.dataLossOrCorruptionProb ?? null;

  const secVal = typeof secNoul === "number" && Number.isFinite(secNoul) ? secNoul : 0;
  const privVal = typeof privNoul === "number" && Number.isFinite(privNoul) ? privNoul : 0;
  const dlVal = typeof dlNoul === "number" && Number.isFinite(dlNoul) ? dlNoul : 0;

  const isRoutineDocsOrTests =
    (category === "documentation" || category === "tests") &&
    safetyGates.length === 0 &&
    secVal < 0.3 &&
    privVal < 0.3 &&
    dlVal < 0.3;

  // 8. hasOnlyGenericSecurityKeywords: body/title contains "security" or "auth" but NO safety gate fired AND security noul < 0.5
  const textToScan = `${item.title || ""} ${item.body || ""}`;
  const hasGenericKeyword = GENERIC_SECURITY_KEYWORDS_REGEX.test(textToScan);
  const hasOnlyGenericSecurityKeywords = hasGenericKeyword && safetyGates.length === 0 && secVal < 0.5;

  // 9. isBotOrCiNoise: item.authorIsBot === true
  const isBotOrCiNoise = item.authorIsBot === true;

  // 10. isMissingDescription: item.body.trim().length === 0
  const isMissingDescription = (item.body ?? "").trim().length === 0;

  return {
    defectImpactIfReal,
    defectRealityConfidence,
    urgency,
    changeComplexity,
    reviewNecessity,
    verifiedFindingSeverity,
    isRoutineDocsOrTests,
    hasOnlyGenericSecurityKeywords,
    isBotOrCiNoise,
    isMissingDescription,
  };
}

/**
 * Classify calibrated band — purely deterministic application logic.
 */
export function calibratePriorityBand(
  dims: CalibrationDimensions,
  originalBand: string,
  deterministicSafetyGates: string[] = [],
): { band: CalibratedPriorityBand; reasons: string[]; suppressedReasons: string[] } {
  const reasons: string[] = [];
  const suppressedReasons: string[] = [];

  const hasSecurityVulnGate = deterministicSafetyGates.some(
    (g) =>
      g === "safety_gate:security_vulnerability" ||
      g.startsWith("safety_gate:security_vulnerability") ||
      g.includes("security_vulnerability"),
  );

  const hasDataLossGate = deterministicSafetyGates.some(
    (g) => g === "safety_gate:data_loss" || g.startsWith("safety_gate:data_loss") || g.includes("data_loss"),
  );

  const anyGateFired = deterministicSafetyGates.length > 0;

  // ── Non-overridable safety gates (always P0) ──────────────────
  if (hasSecurityVulnGate && dims.defectRealityConfidence >= 0.7) {
    reasons.push(
      "safety_gate:security_vulnerability",
      `defect_reality_confidence:${dims.defectRealityConfidence.toFixed(2)}`,
    );
    return { band: "P0_SECURITY_CRITICAL", reasons, suppressedReasons };
  }

  if (hasDataLossGate && dims.urgency >= 0.8) {
    reasons.push("safety_gate:data_loss", `urgency:${dims.urgency.toFixed(2)}`);
    return { band: "P0_OPERATIONAL_CRITICAL", reasons, suppressedReasons };
  }

  // ── Negative controls evaluation ──────────────────────────────
  if (dims.isRoutineDocsOrTests && !anyGateFired) {
    suppressedReasons.push("suppressed_review_complexity_routine_docs_or_tests");
  }

  if (dims.hasOnlyGenericSecurityKeywords && !anyGateFired) {
    suppressedReasons.push("suppressed_p0_generic_security_keywords");
  }

  if (dims.isBotOrCiNoise) {
    suppressedReasons.push("bot_or_ci_noise_capped_at_p2");
  }

  // ── Verified finding (verified high-severity findings) ────────
  if (dims.verifiedFindingSeverity !== null && dims.verifiedFindingSeverity >= 0.8) {
    if (dims.urgency >= 0.8) {
      reasons.push(`verified_operational_finding:${dims.verifiedFindingSeverity.toFixed(2)}`);
      return { band: "P0_OPERATIONAL_CRITICAL", reasons, suppressedReasons };
    }
    reasons.push(`verified_security_finding:${dims.verifiedFindingSeverity.toFixed(2)}`);
    return { band: "P0_SECURITY_CRITICAL", reasons, suppressedReasons };
  }

  // ── Stale or closure candidate signals ────────────────────────
  if (
    originalBand === "P4_STALE_OR_IRRELEVANT" ||
    originalBand.includes("STALE") ||
    originalBand.includes("IRRELEVANT")
  ) {
    reasons.push("stale_or_irrelevant_classification");
    return { band: "P4_STALE_OR_IRRELEVANT", reasons, suppressedReasons };
  }

  if (originalBand === "P3_CLOSURE_CANDIDATE" || originalBand.includes("CLOSURE")) {
    reasons.push("closure_candidate_classification");
    return { band: "P3_CLOSURE_CANDIDATE", reasons, suppressedReasons };
  }

  // ── Missing description / info (needs info before any action) ──
  if (dims.isMissingDescription) {
    if (dims.isBotOrCiNoise) {
      reasons.push("bot_missing_description");
      return { band: "P2_INTERMEDIATE_REVIEW", reasons, suppressedReasons };
    }
    reasons.push("missing_description_information_needed");
    return { band: "P1_INFORMATION_NEEDED", reasons, suppressedReasons };
  }

  // ── Routine docs/tests (negative control: suppress review complexity, route to P3) ──
  if (dims.isRoutineDocsOrTests && !anyGateFired) {
    reasons.push("routine_docs_or_tests_low_risk");
    return { band: "P3_LIGHT_REVIEW", reasons, suppressedReasons };
  }

  // ── Routine low-risk PR (trivial/simple complexity, low risk) ──
  if (dims.changeComplexity <= 0.2 && dims.reviewNecessity < 0.5 && dims.defectRealityConfidence < 0.5) {
    reasons.push("routine_low_risk_change");
    return { band: "P3_LIGHT_REVIEW", reasons, suppressedReasons };
  }

  // ── Complex change with high review necessity (P1_HIGH_REVIEW) ──
  const isComplexReview = (dims.changeComplexity >= 0.7 || dims.reviewNecessity >= 0.8) && !dims.isRoutineDocsOrTests;

  if (isComplexReview) {
    if (dims.isBotOrCiNoise) {
      reasons.push("complex_change_bot_capped_at_p2");
      return { band: "P2_INTERMEDIATE_REVIEW", reasons, suppressedReasons };
    }
    reasons.push(
      `complex_change_high_review(complexity=${dims.changeComplexity.toFixed(2)},necessity=${dims.reviewNecessity.toFixed(2)})`,
    );
    return { band: "P1_HIGH_REVIEW", reasons, suppressedReasons };
  }

  // ── Non-trivial change (complexity > 0.4 or review necessity >= 0.5) ──
  if (dims.changeComplexity > 0.4 || dims.reviewNecessity >= 0.5) {
    reasons.push(
      `intermediate_review(complexity=${dims.changeComplexity.toFixed(2)},necessity=${dims.reviewNecessity.toFixed(2)})`,
    );
    return { band: "P2_INTERMEDIATE_REVIEW", reasons, suppressedReasons };
  }

  // ── Default fallback ──────────────────────────────────────────
  reasons.push("default_intermediate_review");
  return { band: "P2_INTERMEDIATE_REVIEW", reasons, suppressedReasons };
}

/**
 * Convenience helper to produce a complete CalibratedPriorityRecord for an item.
 * Preserves original Jev v2 band and escalation reasons without mutation.
 */
export function calibrateItem(
  item: PRItem,
  originalBand: string,
  originalEscalationReasons: string[] = [],
  jevDecision?: JevDecisionInput,
  overrides?: {
    verifiedFindingSeverity?: number | null;
  },
): CalibratedPriorityRecord {
  const dims = computeCalibrationDimensions(item, jevDecision);
  if (overrides?.verifiedFindingSeverity !== undefined) {
    dims.verifiedFindingSeverity = overrides.verifiedFindingSeverity;
  }
  const gates = jevDecision?.deterministicSafetyGates ?? jevDecision?.routing?.deterministicSafetyGates ?? [];
  const { band, reasons, suppressedReasons } = calibratePriorityBand(dims, originalBand, gates);
  const wasP0InOriginal = originalBand === "P0_CRITICAL";

  return {
    schemaVersion: PRIORITY_CALIBRATION_SCHEMA_VERSION,
    repo: item.repo,
    itemNumber: item.number,
    itemType: item.type === "pr" ? "pr" : "issue",
    title: item.title,
    originalBand,
    originalEscalationReasons: [...originalEscalationReasons],
    calibratedBand: band,
    calibrationReasons: reasons,
    suppressedReasons,
    dimensions: dims,
    calibratedAt: new Date().toISOString(),
    wasP0InOriginal,
    calibrationSchemaVersion: PRIORITY_CALIBRATION_SCHEMA_VERSION,
  };
}

export const calibratePriorityRecord = calibrateItem;

/**
 * Build full P0 calibration analysis from a collection of records.
 */
export function buildP0CalibrationAnalysis(
  records: CalibratedPriorityRecord[],
  originalP0Count: number,
  repo: string,
): P0CalibrationAnalysis {
  const bandDistribution: Record<CalibratedPriorityBand, number> = {
    P0_OPERATIONAL_CRITICAL: 0,
    P0_SECURITY_CRITICAL: 0,
    P1_HIGH_REVIEW: 0,
    P1_INFORMATION_NEEDED: 0,
    P2_INTERMEDIATE_REVIEW: 0,
    P3_LIGHT_REVIEW: 0,
    P3_CLOSURE_CANDIDATE: 0,
    P4_STALE_OR_IRRELEVANT: 0,
  };

  let calibratedP0OperationalCount = 0;
  let calibratedP0SecurityCount = 0;
  let downgradedFromP0 = 0;
  let upgradedToP0 = 0;

  for (const record of records) {
    if (Object.hasOwn(bandDistribution, record.calibratedBand)) {
      bandDistribution[record.calibratedBand]++;
    }

    const isCalibratedP0 =
      record.calibratedBand === "P0_OPERATIONAL_CRITICAL" || record.calibratedBand === "P0_SECURITY_CRITICAL";

    if (record.calibratedBand === "P0_OPERATIONAL_CRITICAL") {
      calibratedP0OperationalCount++;
    } else if (record.calibratedBand === "P0_SECURITY_CRITICAL") {
      calibratedP0SecurityCount++;
    }

    const wasP0 = record.wasP0InOriginal ?? record.originalBand === "P0_CRITICAL";
    if (wasP0 && !isCalibratedP0) {
      downgradedFromP0++;
    } else if (!wasP0 && isCalibratedP0) {
      upgradedToP0++;
    }
  }

  const totalCalibratedP0 = calibratedP0OperationalCount + calibratedP0SecurityCount;

  const findings: string[] = [];
  findings.push(
    `Original P0 items: ${originalP0Count}, Calibrated P0 items: ${totalCalibratedP0} (Operational: ${calibratedP0OperationalCount}, Security: ${calibratedP0SecurityCount})`,
  );
  if (downgradedFromP0 > 0) {
    findings.push(
      `Downgraded ${downgradedFromP0} items from false-positive P0 to high review, information-needed, or routine bands`,
    );
  }
  if (upgradedToP0 > 0) {
    findings.push(
      `Upgraded ${upgradedToP0} items to P0 based on verified high-confidence operational or security criteria`,
    );
  }
  findings.push(
    `Calibrated band breakdown: P1_HIGH_REVIEW=${bandDistribution.P1_HIGH_REVIEW}, P1_INFORMATION_NEEDED=${bandDistribution.P1_INFORMATION_NEEDED}, P2_INTERMEDIATE_REVIEW=${bandDistribution.P2_INTERMEDIATE_REVIEW}, P3_LIGHT_REVIEW=${bandDistribution.P3_LIGHT_REVIEW}, P3_CLOSURE_CANDIDATE=${bandDistribution.P3_CLOSURE_CANDIDATE}, P4_STALE_OR_IRRELEVANT=${bandDistribution.P4_STALE_OR_IRRELEVANT}`,
  );

  return {
    schemaVersion: PRIORITY_CALIBRATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repo,
    originalP0Count,
    calibratedP0OperationalCount,
    calibratedP0SecurityCount,
    totalCalibratedP0,
    downgradedFromP0,
    upgradedToP0,
    bandDistribution,
    findings,
    records,
  };
}
