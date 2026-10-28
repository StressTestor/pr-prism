import { describe, expect, it } from "vitest";
import type { JevFirstDecisionRecord } from "../decisions/triage-v2.js";
import {
  DRAFT_DISCLAIMER,
  extractEditableFields,
  generateChangeRequest,
  generateDeclineOutOfScope,
  generateDuplicateClosureComment,
  generateIssueResolution,
  generateMissingInfoRequest,
  generateMissingTestsRequest,
  generateReviewSummary,
  generateSupersededClosureComment,
} from "../maintainer/drafts.js";
import { formatIssueFinding, formatPrFinding } from "../maintainer/findings.js";
import type { PRItem } from "../types.js";

describe("Maintainer Findings Formatter (Task C)", () => {
  const basePr: PRItem = {
    number: 101,
    type: "pr",
    repo: "octocat/hello-world",
    title: "Fix null pointer in auth handler",
    body: "Resolves issue where token is undefined during retry.\n\nMore details follow.",
    state: "open",
    author: "contributor1",
    authorIsBot: false,
    createdAt: "2026-10-25T12:00:00Z",
    updatedAt: "2026-10-26T14:00:00Z",
    labels: ["bug", "auth"],
    diffUrl: "https://github.com/octocat/hello-world/pull/101.diff",
    ciStatus: "success",
    changedFiles: 2,
    additions: 15,
    deletions: 3,
    hasTests: true,
    headRefOid: "abc123def456",
    closesIssues: [42],
  };

  const baseIssue: PRItem = {
    number: 42,
    type: "issue",
    repo: "octocat/hello-world",
    title: "Auth fails intermittently on reconnect",
    body: "Steps to reproduce:\n1. Disconnect network\n2. Reconnect\nObserved crash.",
    state: "open",
    author: "user_a",
    createdAt: "2026-10-20T08:00:00Z",
    updatedAt: "2026-10-21T09:00:00Z",
    labels: ["needs-triage"],
  };

  const mockJevRecord: JevFirstDecisionRecord = {
    item: {
      repo: "octocat/hello-world",
      number: 101,
      type: "pr",
      title: "Fix null pointer in auth handler",
      fullBodyLength: 200,
      effectiveBodyLength: 200,
      isInputTruncated: false,
    },
    classification: {
      itemType: "pr",
      category: "bug",
      categoryConfidence: 0.88,
      categoryProbabilities: { bug: 0.88 },
      technicalDomain: "auth_crypto",
      technicalDomainConfidence: 0.92,
    },
    derived: {
      priorityTier: "high",
      complexityTier: "simple",
      riskFlags: ["security"],
    },
    scores: {
      operationalPriorityRaw: 2.1,
      operationalPriorityNorm: 0.7,
      operationalPriorityConfidence: 0.85,
      urgentBlockerProb: 0.4,
      securityVulnerabilityProb: 0.75,
      privacyOrPiiProb: 0.1,
      dataLossOrCorruptionProb: 0.05,
      maxSafetyRiskProb: 0.75,
      breakingChangeProb: 0.05,
      productionImpactRaw: 1.5,
      productionImpactNorm: 0.5,
      productionImpactConfidence: 0.8,
      changeComplexityRaw: 0.4,
      changeComplexityNorm: 0.2,
      changeComplexityConfidence: 0.9,
      reproductionEvidenceRaw: 2.0,
      reproductionEvidenceNorm: 0.67,
      reproductionEvidenceConfidence: 0.85,
      missingInformationProb: 0.1,
      goalRelevanceRaw: 2.5,
      goalRelevanceNorm: 0.83,
      goalRelevanceConfidence: 0.9,
      needsDeepReviewProb: 0.3,
    },
    routing: {
      advisory: true,
      escalateToDeepReview: true,
      advisoryRoute: "maintainer_triage",
      escalationReasons: ["security_risk(0.75)"],
      deterministicSafetyGates: ["gate:security"],
      uncertaintyFlags: ["low_confidence_boundary"],
    },
    rawAnswers: {},
    provenance: {
      provider: "jev",
      model: "jev-1.14.0",
      rubricHash: "hash123",
      inputHash: "input123",
      decisionSchemaVersion: "2.0.0",
      decisionIdentity: "identity123",
      evaluatedAt: "2026-10-26T14:00:00Z",
      latencyMs: 120,
      estimatedCostUsd: 0.000021,
    },
  };

  it("formatPrFinding correctly defaults when no optional review/cluster data is provided", () => {
    const finding = formatPrFinding(basePr);

    expect(finding.url).toBe("https://github.com/octocat/hello-world/pull/101");
    expect(finding.state).toBe("open");
    expect(finding.title).toBe("Fix null pointer in auth handler");
    expect(finding.summary).toContain("Resolves issue where token is undefined");
    expect(finding.jevCategory).toBeNull();
    expect(finding.jevUrgency).toBeNull();
    expect(finding.jevRisk).toBeNull();
    expect(finding.duplicateEvidence).toBeNull();
    expect(finding.reviewTier).toBeNull();
    expect(finding.reviewState).toBe("none");
    expect(finding.modelFindings).toHaveLength(0);
    expect(finding.humanReviewStillNeeded).toBe(true);

    expect(finding.sourceBackedFacts).toEqual(
      expect.arrayContaining([
        "State: open",
        "Author: @contributor1",
        "Diff URL: https://github.com/octocat/hello-world/pull/101.diff",
        "CI Status: success",
        "Changes: 2 files (+15/-3)",
        "Tests present: yes",
        "Head OID: abc123def456",
        "Closes issues: #42",
      ]),
    );
  });

  it("formatPrFinding enforces ModelFinding disclaimer invariant", () => {
    const rawReview = {
      summary: "Auth handler looks mostly good but needs token check guard.",
      recommendation: "revise",
      confidence: 0.85,
      findings: [
        {
          severity: "high",
          category: "security",
          fileOrSymbol: "src/auth.ts:validateToken",
          description: "Missing check for expired token before session restore.",
          groundedEvidence: "auth.ts line 45 returns true on expired session.",
        },
      ],
    };

    const finding = formatPrFinding(basePr, { rawReview });

    expect(finding.reviewState).toBe("complete");
    expect(finding.modelFindings).toHaveLength(1);

    const f = finding.modelFindings[0];
    expect(f.severity).toBe("high");
    expect(f.category).toBe("security");
    expect(f.fileOrSymbol).toBe("src/auth.ts:validateToken");
    expect(f.description).toBe("Missing check for expired token before session restore.");
    // Invariant requirement:
    expect(f.disclaimer).toBe("NOTE: Model finding — not independently verified.");
  });

  it("formatPrFinding correctly differentiates identity vs fuzzy duplicate signals", () => {
    // 1. Confirmed identity duplicate
    const confirmedFinding = formatPrFinding(basePr, {
      clusterMembership: {
        clusterId: 5,
        clusterSize: 2,
        isConfirmedDuplicate: true,
        confidence: "high",
        minSimilarity: 1.0,
        relatedNumbers: [99],
      },
    });

    expect(confirmedFinding.duplicateEvidence).not.toBeNull();
    expect(confirmedFinding.duplicateEvidence?.isConfirmed).toBe(true);
    expect(confirmedFinding.duplicateEvidence?.note).toBe("Confirmed: identical head commit or patch-id.");
    expect(confirmedFinding.suggestedAction).toBe("Close as confirmed duplicate of #99");

    // 2. Fuzzy similarity candidate
    const fuzzyFinding = formatPrFinding(basePr, {
      clusterMembership: {
        clusterId: 5,
        clusterSize: 3,
        isConfirmedDuplicate: false,
        confidence: "solid",
        minSimilarity: 0.87,
        relatedNumbers: [99, 100],
      },
    });

    expect(fuzzyFinding.duplicateEvidence?.isConfirmed).toBe(false);
    expect(fuzzyFinding.duplicateEvidence?.note).toBe(
      "Embedding similarity is a candidate signal only — not a confirmed duplicate without human verification.",
    );
    expect(fuzzyFinding.modelRecommendations.some((r) => r.includes("Cluster candidate #5"))).toBe(true);
  });

  it("formatPrFinding cleanly extracts Jev triage data and flags", () => {
    const finding = formatPrFinding(basePr, {
      jevRecord: mockJevRecord,
      reviewTier: "tier-1",
    });

    expect(finding.jevCategory).toBe("bug");
    expect(finding.jevUrgency).toBe("high");
    expect(finding.jevRisk).toEqual({
      security: true,
      breakingChange: false,
      dataLoss: false,
    });
    expect(finding.reviewTier).toBe("tier-1");
    expect(finding.modelUncertainties).toContain("low_confidence_boundary");
    expect(finding.modelRecommendations).toContain("Jev category (advisory): bug");
    expect(finding.modelRecommendations).toContain("Jev priority tier: high");
  });

  it("formatIssueFinding parses issue-specific fields", () => {
    const rawIssueReview = {
      summary: "Intermittent reconnect bug caused by uncaught socket reset.",
      issueAction: "confirm_bug",
      validityAssessment: "valid_actionable",
      reproductionAssessment: "Reliable reproduction steps provided in description.",
      missingEvidence: ["Client OS logs"],
      suggestedNextSteps: ["Reproduce with mock socket server", "Add retry timer"],
      confidence: 0.9,
      concerns: ["Edge case on macOS not verified"],
    };

    const finding = formatIssueFinding(baseIssue, {
      rawReview: rawIssueReview,
      jevRecord: mockJevRecord,
    });

    expect(finding.url).toBe("https://github.com/octocat/hello-world/issues/42");
    expect(finding.summary).toBe("Intermittent reconnect bug caused by uncaught socket reset.");
    expect(finding.issueAction).toBe("confirm_bug");
    expect(finding.validityAssessment).toBe("valid_actionable");
    expect(finding.reproductionAssessment).toBe("Reliable reproduction steps provided in description.");
    expect(finding.missingEvidence).toEqual(["Client OS logs"]);
    expect(finding.suggestedNextSteps).toEqual(["Reproduce with mock socket server", "Add retry timer"]);
    expect(finding.reviewConfidence).toBe(0.9);
    expect(finding.modelUncertainties).toContain("Edge case on macOS not verified");
    expect(finding.suggestedAction).toBe("confirm_bug");
    expect(finding.humanReviewStillNeeded).toBe(true);
  });
});

describe("Deterministic Draft Comment Generator (Task D)", () => {
  it("generateDuplicateClosureComment handles confirmed identity duplicates", () => {
    const draft = generateDuplicateClosureComment({
      repo: "octocat/hello-world",
      number: 102,
      title: "Fix auth typo",
      canonicalNumber: 101,
      isConfirmed: true,
    });

    expect(draft.type).toBe("duplicate_closure");
    expect(draft.itemNumber).toBe(102);
    expect(draft.repo).toBe("octocat/hello-world");
    expect(draft.subject).toBe("Fix auth typo");
    expect(draft.disclaimer).toBe(DRAFT_DISCLAIMER);
    expect(draft.body).toContain(DRAFT_DISCLAIMER);
    expect(draft.body).toContain("This is a confirmed duplicate (identical commit/patch).");
    expect(draft.body).toContain("consolidating discussion and review on #101");
    expect(draft.editableFields).toContain("maintainer rationale or additional notes");
  });

  it("generateDuplicateClosureComment handles fuzzy embedding candidates with required disclaimer phrasing", () => {
    const draft = generateDuplicateClosureComment({
      repo: "octocat/hello-world",
      number: 102,
      title: "Refactor auth token logic",
      canonicalNumber: 101,
      isConfirmed: false,
      confidence: "solid",
    });

    expect(draft.body).toContain(
      "I've identified this as a likely duplicate based on semantic similarity. Please review both to confirm before closing.",
    );
    expect(draft.body).toContain("Similarity confidence: solid.");
  });

  it("generateSupersededClosureComment generates clean consolidated closure draft", () => {
    const draft = generateSupersededClosureComment({
      repo: "octocat/hello-world",
      number: 50,
      title: "Initial auth overhaul",
      supersededByNumber: 75,
      supersededByTitle: "V2 auth system architecture",
    });

    expect(draft.type).toBe("superseded_closure");
    expect(draft.body).toContain('superseded by #75 ("V2 auth system architecture")');
    expect(draft.editableFields).toContain("additional context or migration instructions for author");
  });

  it("generateMissingInfoRequest handles PRs and issues with formatted items list", () => {
    const draft = generateMissingInfoRequest({
      repo: "octocat/hello-world",
      number: 42,
      title: "Crash on startup",
      type: "issue",
      missingItems: ["Node.js runtime version", "Full stack trace", "Minimal reproduction repo"],
    });

    expect(draft.type).toBe("request_info");
    expect(draft.body).toContain("Thanks for opening this issue!");
    expect(draft.body).toContain("- Node.js runtime version");
    expect(draft.body).toContain("- Full stack trace");
    expect(draft.body).toContain("- Minimal reproduction repo");
    expect(draft.editableFields).toContain("specific details or questions for contributor");
  });

  it("generateMissingTestsRequest formats changed files list", () => {
    const draft = generateMissingTestsRequest({
      repo: "octocat/hello-world",
      number: 101,
      title: "Add rate limiting",
      changedFiles: ["src/limiter.ts", "src/server.ts"],
    });

    expect(draft.type).toBe("request_tests");
    expect(draft.body).toContain("- `src/limiter.ts`");
    expect(draft.body).toContain("- `src/server.ts`");
    expect(draft.body).toContain("Could you please add tests covering the changes?");
    expect(draft.editableFields).toContain("suggested test files or testing guidance");
  });

  it("generateChangeRequest structures review findings into markdown checkboxes", () => {
    const draft = generateChangeRequest({
      repo: "octocat/hello-world",
      number: 101,
      title: "Add crypto helpers",
      findings: [
        {
          severity: "high",
          description: "Insecure salt generation",
          fileOrSymbol: "src/crypto.ts",
        },
        {
          severity: "medium",
          description: "Missing timeout parameter",
        },
      ],
      reviewerNote: "Please update the PR against main once these are fixed.",
    });

    expect(draft.type).toBe("change_request");
    expect(draft.body).toContain("- [ ] **[HIGH]** `src/crypto.ts`: Insecure salt generation");
    expect(draft.body).toContain("- [ ] **[MEDIUM]** Missing timeout parameter");
    expect(draft.body).toContain("Please update the PR against main once these are fixed.");
    expect(draft.editableFields).toContain("maintainer feedback and instructions for next iteration");
  });

  it("generateReviewSummary formats recommendation, summary, and concerns", () => {
    const draft = generateReviewSummary({
      repo: "octocat/hello-world",
      number: 101,
      title: "Update dependencies",
      recommendation: "merge",
      summary: "All unit and integration tests pass cleanly with zero deprecations.",
      concerns: ["Bumps minor version of fast-glob; verified no breaking changes"],
    });

    expect(draft.type).toBe("review_summary");
    expect(draft.body).toContain("**Recommendation:** merge");
    expect(draft.body).toContain("All unit and integration tests pass cleanly");
    expect(draft.body).toContain("- Bumps minor version of fast-glob");
    expect(draft.editableFields).toContain("maintainer final assessment or approval conditions");
  });

  it("generateIssueResolution references resolving PRs", () => {
    const draft = generateIssueResolution({
      repo: "octocat/hello-world",
      number: 30,
      title: "Memory leak in event loop",
      resolution: "Closed via event listener unbinding on disconnect",
      relatedPrNumbers: [105, 108],
    });

    expect(draft.type).toBe("issue_resolution");
    expect(draft.body).toContain("**Resolution:** Closed via event listener unbinding on disconnect");
    expect(draft.body).toContain("Resolved by pull request(s): #105, #108");
    expect(draft.editableFields).toContain("resolution explanation or release version details");
  });

  it("generateDeclineOutOfScope provides polite decline with optional explanation", () => {
    const draft = generateDeclineOutOfScope({
      repo: "octocat/hello-world",
      number: 88,
      title: "Add support for alternative legacy database",
      scopeExplanation: "We currently only support PostgreSQL and SQLite as per our 2026 roadmap.",
    });

    expect(draft.type).toBe("decline_out_of_scope");
    expect(draft.body).toContain("falls outside the current scope and roadmap");
    expect(draft.body).toContain("We currently only support PostgreSQL and SQLite");
    expect(draft.editableFields).toContain("reason for declining and roadmap alignment explanation");
  });

  it("extractEditableFields correctly extracts and deduplicates placeholders", () => {
    const text = `
      Some intro
      <!-- EDIT: field one -->
      Middle text
      <!-- EDIT: field two -->
      Duplicate
      <!-- EDIT: field one -->
    `;

    const fields = extractEditableFields(text);
    expect(fields).toEqual(["field one", "field two"]);
  });

  it("sanitizes titles with control characters and newlines", () => {
    const draft = generateDuplicateClosureComment({
      repo: "octocat/hello-world",
      number: 101,
      title: "Malicious title\nwith\rnewlines\u0000and controls",
      canonicalNumber: 99,
      isConfirmed: true,
    });

    expect(draft.subject).toBe("Malicious title with newlines and controls");
    expect(draft.subject).not.toContain("\n");
    expect(draft.subject).not.toContain("\r");
    expect(draft.subject).not.toContain("\u0000");
  });
});
