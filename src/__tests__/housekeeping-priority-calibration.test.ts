import { describe, expect, it } from "vitest";
import {
  buildP0CalibrationAnalysis,
  type CalibratedPriorityBand,
  calibrateItem,
  calibratePriorityBand,
  computeCalibrationDimensions,
  PRIORITY_CALIBRATION_SCHEMA_VERSION,
} from "../housekeeping/priority-calibration.js";
import type { PRItem } from "../types.js";

function makeItem(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 42,
    type: "pr",
    repo: "test-owner/test-repo",
    title: "Routine maintenance update",
    body: "Detailed explanation of changes made.",
    state: "open",
    author: "contributor",
    authorIsBot: false,
    createdAt: "2026-02-01T12:00:00Z",
    updatedAt: "2026-02-02T12:00:00Z",
    labels: [],
    ...overrides,
  };
}

describe("Housekeeping — Priority Calibration (Schema v1.0.0)", () => {
  it("exposes the correct schema version constant", () => {
    expect(PRIORITY_CALIBRATION_SCHEMA_VERSION).toBe("1.0.0");
    const validBand: CalibratedPriorityBand = "P0_OPERATIONAL_CRITICAL";
    expect(validBand).toBe("P0_OPERATIONAL_CRITICAL");
  });

  // 1. Negative control — docs/tests NOT escalated to P0
  it("1. Negative control — docs/tests NOT escalated to P0: category=documentation, no safety gates, security keyword 'auth' in title → P3_LIGHT_REVIEW", () => {
    const item = makeItem({
      title: "Update auth documentation and guide",
      body: "Explains how the authentication flow works in the architecture docs.",
      labels: ["docs"],
    });

    const jevDecision = {
      category: "documentation",
      deterministicSafetyGates: [],
      scores: {
        securityVulnerabilityRisk: { noul: 0.1 },
        privacyOrPiiRisk: { noul: 0.05 },
        dataLossOrCorruptionRisk: { noul: 0.0 },
      },
      priorityTier: "low",
      complexityTier: "simple",
    };

    const dims = computeCalibrationDimensions(item, jevDecision);
    expect(dims.isRoutineDocsOrTests).toBe(true);
    expect(dims.hasOnlyGenericSecurityKeywords).toBe(true);

    const result = calibratePriorityBand(dims, "P0_CRITICAL", []);
    expect(result.band).toBe("P3_LIGHT_REVIEW");
    expect(result.suppressedReasons).toContain("suppressed_review_complexity_routine_docs_or_tests");
    expect(result.suppressedReasons).toContain("suppressed_p0_generic_security_keywords");
  });

  // 2. Negative control — generic security keyword suppressed
  it("2. Negative control — generic security keyword suppressed: body='security improvements' but no gate, security noul=0.2 → NOT P0", () => {
    const item = makeItem({
      title: "Refactor internal token parsing utility",
      body: "Some general security improvements in the helper module.",
    });

    const jevDecision = {
      category: "refactor",
      deterministicSafetyGates: [],
      scores: {
        securityVulnerabilityRisk: { noul: 0.2 },
        urgentBlocker: { noul: 0.1 },
      },
      priorityTier: "medium",
      complexityTier: "moderate",
    };

    const dims = computeCalibrationDimensions(item, jevDecision);
    expect(dims.hasOnlyGenericSecurityKeywords).toBe(true);

    const result = calibratePriorityBand(dims, "P0_CRITICAL", []);
    expect(result.band).not.toBe("P0_OPERATIONAL_CRITICAL");
    expect(result.band).not.toBe("P0_SECURITY_CRITICAL");
    expect(result.band).toBe("P2_INTERMEDIATE_REVIEW");
    expect(result.suppressedReasons).toContain("suppressed_p0_generic_security_keywords");
  });

  // 3. Real P0 security
  it("3. Real P0 security: safety_gate:security_vulnerability fired AND defectRealityConfidence=0.8 → P0_SECURITY_CRITICAL", () => {
    const item = makeItem({
      title: "Fix critical authentication bypass in session validator",
      body: "An unauthenticated user can spoof JWT headers and gain full admin access.",
      labels: ["security"],
    });

    const jevDecision = {
      category: "security",
      deterministicSafetyGates: ["safety_gate:security_vulnerability"],
      scores: {
        securityVulnerabilityRisk: { noul: 0.8 },
        urgentBlocker: { noul: 0.5 },
      },
    };

    const dims = computeCalibrationDimensions(item, jevDecision);
    expect(dims.defectRealityConfidence).toBe(0.8);

    const result = calibratePriorityBand(dims, "P0_CRITICAL", jevDecision.deterministicSafetyGates);
    expect(result.band).toBe("P0_SECURITY_CRITICAL");
    expect(result.reasons).toContain("safety_gate:security_vulnerability");
  });

  // 4. Real P0 operational
  it("4. Real P0 operational: safety_gate:data_loss fired AND urgency=0.9 → P0_OPERATIONAL_CRITICAL", () => {
    const item = makeItem({
      title: "Fix silent table drop during migration in production",
      body: "Database migration drops production user accounts table unexpectedly.",
      labels: ["critical"],
    });

    const jevDecision = {
      category: "bug",
      deterministicSafetyGates: ["safety_gate:data_loss"],
      scores: {
        urgentBlocker: { noul: 0.9 },
        dataLossOrCorruptionRisk: { noul: 0.95 },
      },
    };

    const dims = computeCalibrationDimensions(item, jevDecision);
    expect(dims.urgency).toBe(1.0); // label "critical" sets urgency to 1.0 (or ubNoul 0.9)

    const result = calibratePriorityBand(dims, "P0_CRITICAL", jevDecision.deterministicSafetyGates);
    expect(result.band).toBe("P0_OPERATIONAL_CRITICAL");
    expect(result.reasons).toContain("safety_gate:data_loss");
  });

  // 5. Complex PR not urgent → P1_HIGH_REVIEW
  it("5. Complex PR not urgent → P1_HIGH_REVIEW (not P0)", () => {
    const item = makeItem({
      title: "Redesign multi-region distributed consensus protocol",
      body: "Architectural overhaul of consensus coordinator across 5 data centers.",
    });

    const jevDecision = {
      category: "refactor",
      complexityTier: "complex",
      priorityTier: "high",
      deterministicSafetyGates: [],
      scores: {
        urgentBlocker: { noul: 0.2 },
        productionImpact: { norm: 0.6 },
      },
    };

    const dims = computeCalibrationDimensions(item, jevDecision);
    expect(dims.changeComplexity).toBe(0.9);
    expect(dims.reviewNecessity).toBe(0.8);
    expect(dims.urgency).toBe(0.2);

    const result = calibratePriorityBand(dims, "P0_CRITICAL", []);
    expect(result.band).toBe("P1_HIGH_REVIEW");
    expect(result.band).not.toBe("P0_OPERATIONAL_CRITICAL");
    expect(result.band).not.toBe("P0_SECURITY_CRITICAL");
  });

  // 6. Missing description → P1_INFORMATION_NEEDED
  it("6. Missing description → P1_INFORMATION_NEEDED", () => {
    const item = makeItem({
      title: "Fix problem in backend",
      body: "   ", // whitespace only
    });

    const dims = computeCalibrationDimensions(item);
    expect(dims.isMissingDescription).toBe(true);

    const result = calibratePriorityBand(dims, "P0_CRITICAL", []);
    expect(result.band).toBe("P1_INFORMATION_NEEDED");
    expect(result.reasons).toContain("missing_description_information_needed");
  });

  // 7. Bot author → max P2
  it("7. Bot author → max P2: bot PRs cannot escalate to P0 or P1", () => {
    const item = makeItem({
      title: "Bump dependency from 1.0.0 to 2.0.0 with breaking api changes",
      body: "Automated dependency upgrade generated by bot.",
      author: "dependabot[bot]",
      authorIsBot: true,
    });

    const jevDecision = {
      complexityTier: "complex",
      priorityTier: "high",
      deterministicSafetyGates: [],
    };

    const dims = computeCalibrationDimensions(item, jevDecision);
    expect(dims.isBotOrCiNoise).toBe(true);

    const result = calibratePriorityBand(dims, "P0_CRITICAL", []);
    expect(result.band).toBe("P2_INTERMEDIATE_REVIEW");
    expect(result.suppressedReasons).toContain("bot_or_ci_noise_capped_at_p2");
  });

  // 8. Routine PR (complexity=trivial, no risk) → P3_LIGHT_REVIEW
  it("8. Routine PR (complexity=trivial, no risk) → P3_LIGHT_REVIEW", () => {
    const item = makeItem({
      title: "Fix minor typo in error message",
      body: "Fixes spelling of 'received' in debug log.",
    });

    const jevDecision = {
      complexityTier: "trivial",
      priorityTier: "low",
      deterministicSafetyGates: [],
      scores: {
        securityVulnerabilityRisk: { noul: 0.05 },
        urgentBlocker: { noul: 0.05 },
      },
    };

    const dims = computeCalibrationDimensions(item, jevDecision);
    expect(dims.changeComplexity).toBe(0.0);
    expect(dims.reviewNecessity).toBe(0.2);

    const result = calibratePriorityBand(dims, "P3_ROUTINE_LOCAL", []);
    expect(result.band).toBe("P3_LIGHT_REVIEW");
    expect(result.reasons).toContain("routine_low_risk_change");
  });

  // 9. buildP0CalibrationAnalysis counts correctly
  it("9. buildP0CalibrationAnalysis counts correctly", () => {
    const itemP0Sec = makeItem({ number: 101, title: "Auth zero-day" });
    const recP0Sec = calibrateItem(itemP0Sec, "P0_CRITICAL", ["safety_gate:security_vulnerability"], {
      deterministicSafetyGates: ["safety_gate:security_vulnerability"],
      scores: { securityVulnerabilityRisk: { noul: 0.9 } },
    });

    const itemP0Op = makeItem({ number: 102, title: "Data loss bug" });
    const recP0Op = calibrateItem(itemP0Op, "P0_CRITICAL", ["safety_gate:data_loss"], {
      deterministicSafetyGates: ["safety_gate:data_loss"],
      scores: { urgentBlocker: { noul: 0.85 } },
    });

    const itemP1 = makeItem({ number: 103, title: "Complex refactor" });
    const recP1 = calibrateItem(itemP1, "P0_CRITICAL", ["large_diff"], {
      complexityTier: "complex",
      priorityTier: "high",
    });

    const itemP3 = makeItem({ number: 104, title: "Docs typo" });
    const recP3 = calibrateItem(itemP3, "P3_ROUTINE_LOCAL", [], {
      complexityTier: "trivial",
      priorityTier: "low",
    });

    const records = [recP0Sec, recP0Op, recP1, recP3];
    const analysis = buildP0CalibrationAnalysis(records, 3, "test-owner/test-repo");

    expect(analysis.originalP0Count).toBe(3);
    expect(analysis.calibratedP0SecurityCount).toBe(1);
    expect(analysis.calibratedP0OperationalCount).toBe(1);
    expect(analysis.totalCalibratedP0).toBe(2);
    expect(analysis.downgradedFromP0).toBe(1); // recP1 was original P0, now P1
    expect(analysis.upgradedToP0).toBe(0);
    expect(analysis.bandDistribution.P0_SECURITY_CRITICAL).toBe(1);
    expect(analysis.bandDistribution.P0_OPERATIONAL_CRITICAL).toBe(1);
    expect(analysis.bandDistribution.P1_HIGH_REVIEW).toBe(1);
    expect(analysis.bandDistribution.P3_LIGHT_REVIEW).toBe(1);
    expect(analysis.findings.length).toBeGreaterThan(0);
  });

  // 10. originalBand NEVER mutated
  it("10. originalBand NEVER mutated — the original Jev v2 band is always preserved in the record", () => {
    const item = makeItem({ number: 200, title: "Routine PR" });
    const originalBand = "P0_CRITICAL";
    const originalReasons = ["priority:critical", "production_impact"];

    const record = calibrateItem(item, originalBand, originalReasons, {
      complexityTier: "simple",
      priorityTier: "low",
    });

    expect(record.originalBand).toBe("P0_CRITICAL");
    expect(record.originalEscalationReasons).toEqual(["priority:critical", "production_impact"]);
    expect(record.calibratedBand).not.toBe("P0_CRITICAL");
    expect(record.calibratedBand).toBe("P3_LIGHT_REVIEW");
  });

  // 11. wasP0InOriginal correctly flagged
  it("11. wasP0InOriginal correctly flagged", () => {
    const item1 = makeItem({ number: 301 });
    const item2 = makeItem({ number: 302 });

    const record1 = calibrateItem(item1, "P0_CRITICAL");
    const record2 = calibrateItem(item2, "P2_MODERATE");

    expect(record1.wasP0InOriginal).toBe(true);
    expect(record2.wasP0InOriginal).toBe(false);
  });

  // 12. downgradedFromP0 counts items where originalBand was P0_CRITICAL but calibratedBand is not P0_x
  it("12. downgradedFromP0 counts items where originalBand was P0_CRITICAL but calibratedBand is not P0_x", () => {
    const item1 = makeItem({ number: 401, title: "Former P0 false positive 1" });
    const item2 = makeItem({
      number: 402,
      title: "Former P0 false positive 2",
      body: "",
    });
    const item3 = makeItem({ number: 403, title: "True P0 security incident" });

    const rec1 = calibrateItem(item1, "P0_CRITICAL", [], {
      complexityTier: "moderate",
      priorityTier: "medium",
    }); // -> P2_INTERMEDIATE_REVIEW
    const rec2 = calibrateItem(item2, "P0_CRITICAL", []); // -> P1_INFORMATION_NEEDED
    const rec3 = calibrateItem(item3, "P0_CRITICAL", [], {
      deterministicSafetyGates: ["safety_gate:security_vulnerability"],
      scores: { securityVulnerabilityRisk: { noul: 0.85 } },
    }); // -> P0_SECURITY_CRITICAL

    const analysis = buildP0CalibrationAnalysis([rec1, rec2, rec3], 3, "test/repo");
    expect(analysis.downgradedFromP0).toBe(2);
    expect(analysis.totalCalibratedP0).toBe(1);
  });

  // 13. False-positive security keyword test
  it("13. False-positive security keyword test: 'fix authentication flow' with no gates, low security noul → NOT P0", () => {
    const item = makeItem({
      title: "fix authentication flow",
      body: "Minor bugfix in user login redirection logic.",
    });

    const jevDecision = {
      category: "bug",
      deterministicSafetyGates: [],
      scores: {
        securityVulnerabilityRisk: { noul: 0.15 },
        urgentBlocker: { noul: 0.1 },
      },
      priorityTier: "medium",
      complexityTier: "moderate",
    };

    const dims = computeCalibrationDimensions(item, jevDecision);
    expect(dims.hasOnlyGenericSecurityKeywords).toBe(true);

    const result = calibratePriorityBand(dims, "P0_CRITICAL", []);
    expect(result.band).not.toBe("P0_SECURITY_CRITICAL");
    expect(result.band).not.toBe("P0_OPERATIONAL_CRITICAL");
    expect(result.band).toBe("P2_INTERMEDIATE_REVIEW");
  });

  // 14. verifiedFindingSeverity null when no verified finding
  it("14. verifiedFindingSeverity null when no verified finding", () => {
    const item = makeItem();
    const dims = computeCalibrationDimensions(item);
    expect(dims.verifiedFindingSeverity).toBeNull();
  });

  // Additional edge cases & comprehensive coverage
  it("handles verified finding severity >= 0.8 promoting to P0", () => {
    const item = makeItem({ title: "Verified critical vulnerability" });
    const recSec = calibrateItem(item, "P1_HIGH", [], undefined, {
      verifiedFindingSeverity: 0.95,
    });
    expect(recSec.calibratedBand).toBe("P0_SECURITY_CRITICAL");

    const itemOp = makeItem({ title: "Verified operational disaster" });
    const recOp = calibrateItem(
      itemOp,
      "P1_HIGH",
      [],
      {
        scores: { urgentBlocker: { noul: 0.9 } },
      },
      {
        verifiedFindingSeverity: 0.9,
      },
    );
    expect(recOp.calibratedBand).toBe("P0_OPERATIONAL_CRITICAL");
  });

  it("handles closure candidate and stale bands preservation", () => {
    const dims = computeCalibrationDimensions(makeItem());
    const resClosure = calibratePriorityBand(dims, "P3_CLOSURE_CANDIDATE");
    expect(resClosure.band).toBe("P3_CLOSURE_CANDIDATE");

    const resStale = calibratePriorityBand(dims, "P4_STALE_OR_IRRELEVANT");
    expect(resStale.band).toBe("P4_STALE_OR_IRRELEVANT");
  });

  it("handles upgradedToP0 count when a non-P0 item is promoted to calibrated P0", () => {
    const item = makeItem({ number: 501, title: "Promoted security exploit" });
    const rec = calibrateItem(
      item,
      "P1_HIGH", // was NOT P0 in original
      [],
      {
        deterministicSafetyGates: ["safety_gate:security_vulnerability"],
        scores: { securityVulnerabilityRisk: { noul: 0.85 } },
      },
    );

    const analysis = buildP0CalibrationAnalysis([rec], 0, "test/repo");
    expect(analysis.upgradedToP0).toBe(1);
    expect(analysis.downgradedFromP0).toBe(0);
    expect(analysis.totalCalibratedP0).toBe(1);
  });
});
