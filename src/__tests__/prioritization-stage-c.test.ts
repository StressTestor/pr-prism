import { describe, expect, it, vi } from "vitest";
import {
  composeJevFirstDecisionRecord,
  JEV_FIRST_SCHEMA_VERSION,
  type JevFirstDecisionRecord,
} from "../decisions/triage-v2.js";
import type { DecisionAnswer, DecisionProvenance } from "../decisions/types.js";
import {
  buildReproducibleEscalationQueue,
  makeItemKey,
  prioritizeIssues,
  prioritizePullRequests,
} from "../prioritization.js";
import type { Cluster, PRItem } from "../types.js";

function createMockPR(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 10,
    type: "pr",
    repo: "odysseus-dev/odysseus",
    title: "Refactor cache eviction algorithm",
    body: "Refactors LRU cache eviction logic with improved locking primitives.",
    state: "open",
    author: "senior-dev",
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
    labels: [],
    ciStatus: "success",
    reviewCount: 2,
    additions: 120,
    deletions: 40,
    changedFiles: 4,
    hasTests: true,
    headRefOid: "commit_abc123",
    ...overrides,
  };
}

function createMockIssue(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 50,
    type: "issue",
    repo: "odysseus-dev/odysseus",
    title: "Session timeout expires prematurely on mobile browsers",
    body: "Steps to reproduce:\n1. Open on mobile Safari\n2. Wait 5 minutes\nObserved: Logged out prematurely.",
    state: "open",
    author: "community-user",
    createdAt: "2026-10-18T10:00:00Z",
    updatedAt: "2026-10-19T10:00:00Z",
    labels: [],
    ...overrides,
  };
}

function createMockJevDecision(
  item: PRItem,
  customAnswers: Partial<Record<string, DecisionAnswer>> = {},
): JevFirstDecisionRecord {
  const defaultAnswers: Record<string, DecisionAnswer> = {
    category: {
      type: "choice",
      choice: "refactor",
      confidence: 0.95,
      probabilities: { refactor: 0.95, bug: 0.05 },
    },
    technical_domain: {
      type: "choice",
      choice: "core_logic",
      confidence: 0.9,
      probabilities: { core_logic: 0.9, other: 0.1 },
    },
    operational_priority: {
      type: "score",
      score: 1, // Medium
      confidence: 0.9,
      probabilities: { "1": 0.9, "0": 0.1 },
    },
    is_urgent_blocker: {
      type: "noul",
      noul: 0.05,
    },
    security_vulnerability_risk: {
      type: "noul",
      noul: 0.02,
    },
    privacy_or_pii_risk: {
      type: "noul",
      noul: 0.01,
    },
    data_loss_or_corruption_risk: {
      type: "noul",
      noul: 0.01,
    },
    breaking_change_risk: {
      type: "noul",
      noul: 0.05,
    },
    production_impact: {
      type: "score",
      score: 1, // Moderate
      confidence: 0.88,
      probabilities: { "1": 0.88, "0": 0.12 },
    },
    change_complexity: {
      type: "score",
      score: 1, // Moderate
      confidence: 0.9,
      probabilities: { "1": 0.9, "0": 0.1 },
    },
    reproduction_evidence: {
      type: "score",
      score: 2, // Complete
      confidence: 0.9,
      probabilities: { "2": 0.9, "1": 0.1 },
    },
    missing_information: {
      type: "noul",
      noul: 0.05,
    },
    goal_relevance: {
      type: "score",
      score: 2, // High
      confidence: 0.92,
      probabilities: { "2": 0.92, "1": 0.08 },
    },
    needs_deep_review: {
      type: "noul",
      noul: 0.1,
    },
    ...customAnswers,
  };

  const provenance: DecisionProvenance = {
    provider: "mock",
    model: "jev-1.14.0",
    inputHash: `input_hash_${item.number}`,
    decisionSchemaVersion: JEV_FIRST_SCHEMA_VERSION,
    rubricHash: "rubric_hash_v2",
    decisionIdentity: `identity_${item.type}_${item.number}`,
    usage: { inputTokens: 1100, outputTokens: 0 },
    latencyMs: 95,
    evaluatedAt: "2026-10-27T12:00:00Z",
  };

  return composeJevFirstDecisionRecord(item, defaultAnswers, provenance);
}

describe("Stage C — Transparent Deterministic Prioritization & GLM Escalation Policy", () => {
  describe("Requirement 1: Separate PR & Issue Handling with Preserved Objective Signals", () => {
    it("prioritizes pull requests retaining PR-Prism objective score and inspecting all feature dimensions", () => {
      const pr = createMockPR({
        number: 10,
        additions: 150,
        deletions: 50,
        ciStatus: "success",
        hasTests: true,
      });

      const jev = createMockJevDecision(pr);
      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("pr", 10), jev]]);

      const results = prioritizePullRequests([pr], { jevDecisionsByKey: jevMap });

      expect(results).toHaveLength(1);
      const p = results[0];

      // Objective signals preserved
      expect(p.type).toBe("pr");
      expect(p.number).toBe(10);
      expect(p.objectiveScore).toBeGreaterThan(0);
      expect(p.objectiveSignals).toBeDefined();
      expect(p.objectiveSignals.ciPassing).toBe(1);
      expect(p.objectiveSignals.hasTests).toBe(1);

      // Separately inspectable features
      expect(p.githubMetadata).toBeDefined();
      expect(p.githubMetadata.totalDiffLines).toBe(200);
      expect(p.githubMetadata.ciStatus).toBe("success");
      expect(p.githubMetadata.hasTests).toBe(true);

      expect(p.duplicateFeatures).toBeDefined();
      expect(p.duplicateFeatures.isClusterBestPick).toBe(true);

      expect(p.jevFeatures).toBeDefined();
      expect(p.jevFeatures.available).toBe(true);
      expect(p.jevFeatures.model).toBe("jev-1.14.0");
      expect(p.jevFeatures.category).toBe("refactor");

      // Score breakdown transparency
      expect(p.breakdown).toBeDefined();
      expect(p.breakdown.objectiveBaseScore).toBeGreaterThan(0);
      expect(p.breakdown.jevOperationalUrgencyComponent).toBeGreaterThan(0);
      expect(p.breakdown.safetyAndRiskComponent).toBeGreaterThan(0);
      expect(p.breakdown.compositePriorityScore).toBeGreaterThan(0);

      // Dedicated prSpecific block
      expect(p.prSpecific).toBeDefined();
      expect(p.prSpecific.isLargeUnverifiedDiff).toBe(false);
      expect(p.prSpecific.hasFailingCiWithHighImpact).toBe(false);
      expect(["ready_candidate", "needs_deep_review", "needs_ci_or_tests", "duplicate_candidate"]).toContain(
        p.prSpecific.mergeReadinessTier,
      );
    });

    it("prioritizes issues separately without penalizing for PR-only fields", () => {
      const issue = createMockIssue({
        number: 50,
        body: "A detailed issue report with complete steps and logs.",
      });

      const jev = createMockJevDecision(issue);
      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("issue", 50), jev]]);

      // Pass mixed list; prioritizeIssues only processes issues
      const pr = createMockPR({ number: 99 });
      const results = prioritizeIssues([pr, issue], { jevDecisionsByKey: jevMap });

      expect(results).toHaveLength(1);
      const itm = results[0];

      expect(itm.type).toBe("issue");
      expect(itm.number).toBe(50);
      expect(itm.githubMetadata.additions).toBeNull();
      expect(itm.githubMetadata.deletions).toBeNull();
      expect(itm.githubMetadata.totalDiffLines).toBeNull();
      expect(itm.githubMetadata.ciStatus).toBe("unknown");

      // Dedicated issueSpecific block
      expect(itm.issueSpecific).toBeDefined();
      expect(itm.issueSpecific.hasLinkedOpenPR).toBe(false);
      expect(itm.issueSpecific.linkedOpenPrNumbers).toEqual([]);
      expect(itm.issueSpecific.triageActionability).toBeDefined();
    });
  });

  describe("Requirement 2: Duplicate Cluster Adjustments & Linked PRs", () => {
    it("rewards canonical best pick with +2.5 for PR and +2.0 for Issue", () => {
      const pr1 = createMockPR({ number: 101, title: "Best pick PR" });
      const pr2 = createMockPR({ number: 102, title: "Duplicate PR" });

      const prCluster: Cluster = {
        id: 1,
        items: [
          { ...pr1, score: 0.85, signals: {} as any },
          { ...pr2, score: 0.65, signals: {} as any },
        ],
        bestPick: { ...pr1, score: 0.85, signals: {} as any },
        avgSimilarity: 0.92,
        minSimilarity: 0.88,
        theme: "Duplicate PRs",
      };

      const results = prioritizePullRequests([pr1, pr2], { clusters: [prCluster] });
      const bestPR = results.find((r) => r.number === 101)!;
      const dupPR = results.find((r) => r.number === 102)!;

      expect(bestPR.duplicateFeatures.isClusterBestPick).toBe(true);
      expect(bestPR.breakdown.duplicateClusterAdjustment).toBe(2.5);

      expect(dupPR.duplicateFeatures.isClusterBestPick).toBe(false);
      expect(dupPR.duplicateFeatures.isNonCanonicalDuplicate).toBe(true);
      expect(dupPR.breakdown.duplicateClusterAdjustment).toBe(-3.5); // Fuzzy duplicate penalty
      expect(dupPR.prSpecific.mergeReadinessTier).toBe("duplicate_candidate");

      // For Issues:
      const iss1 = createMockIssue({ number: 201 });
      const iss2 = createMockIssue({ number: 202 });

      const issueCluster: Cluster = {
        id: 2,
        items: [
          { ...iss1, score: 0.8, signals: {} as any },
          { ...iss2, score: 0.5, signals: {} as any },
        ],
        bestPick: { ...iss1, score: 0.8, signals: {} as any },
        avgSimilarity: 0.9,
        minSimilarity: 0.85,
        theme: "Duplicate Issues",
      };

      const issueResults = prioritizeIssues([iss1, iss2], { clusters: [issueCluster] });
      const bestIss = issueResults.find((r) => r.number === 201)!;
      const dupIss = issueResults.find((r) => r.number === 202)!;

      expect(bestIss.duplicateFeatures.isClusterBestPick).toBe(true);
      expect(bestIss.breakdown.duplicateClusterAdjustment).toBe(2.0);

      expect(dupIss.duplicateFeatures.isNonCanonicalDuplicate).toBe(true);
      expect(dupIss.breakdown.duplicateClusterAdjustment).toBe(-4.0);
    });

    it("penalizes confirmed identity duplicates with -8.0 and marks as duplicate_candidate", () => {
      const pr1 = createMockPR({ number: 301, headRefOid: "identical_hash" });
      const pr2 = createMockPR({ number: 302, headRefOid: "identical_hash" });

      const identityCluster: Cluster = {
        id: 3,
        kind: "identity",
        identity: { basis: "head-oid", key: "identical_hash" },
        items: [
          { ...pr1, score: 0.9, signals: {} as any },
          { ...pr2, score: 0.7, signals: {} as any },
        ],
        bestPick: { ...pr1, score: 0.9, signals: {} as any },
        avgSimilarity: 1.0,
        minSimilarity: 1.0,
        theme: "Identical head OID",
      };

      const results = prioritizePullRequests([pr1, pr2], { clusters: [identityCluster] });
      const dupPR = results.find((r) => r.number === 302)!;

      expect(dupPR.duplicateFeatures.isConfirmedIdentityDuplicate).toBe(true);
      expect(dupPR.duplicateFeatures.isClusterBestPick).toBe(false);
      expect(dupPR.breakdown.duplicateClusterAdjustment).toBe(-8.0);
      expect(dupPR.prSpecific.mergeReadinessTier).toBe("duplicate_candidate");
    });

    it("rewards PR closing tracked issues with +3.0 and updates linked open PR on corresponding issue", () => {
      const pr = createMockPR({ number: 401, closesIssues: [501] });
      const issue = createMockIssue({ number: 501 });

      const prResults = prioritizePullRequests([pr], {});
      const issueResults = prioritizeIssues([pr, issue], {});

      const prioritizedPR = prResults[0];
      const prioritizedIssue = issueResults[0];

      // PR rewards
      expect(prioritizedPR.duplicateFeatures.closesIssueNumbers).toContain(501);
      expect(prioritizedPR.breakdown.duplicateClusterAdjustment).toBe(3.0);

      // Issue rewards & cross-linking
      expect(prioritizedIssue.issueSpecific.hasLinkedOpenPR).toBe(true);
      expect(prioritizedIssue.issueSpecific.linkedOpenPrNumbers).toContain(401);
      expect(prioritizedIssue.breakdown.duplicateClusterAdjustment).toBe(2.5);
      expect(prioritizedIssue.issueSpecific.triageActionability).toBe("actionable_with_pr");
    });
  });

  describe("Requirement 3: Hard Invariant — Seriousness Floor Prevents Excluding Serious Items", () => {
    it("escalates a 600-line diff PR even when Jev assigns negligible risk (0.02)", () => {
      const pr = createMockPR({
        number: 601,
        additions: 400,
        deletions: 200, // totalDiffLines = 600
        hasTests: true,
      });

      // Jev returns 0.02 risk
      const lowRiskJev = createMockJevDecision(pr, {
        security_vulnerability_risk: { type: "noul", noul: 0.02 },
        needs_deep_review: { type: "noul", noul: 0.05 },
      });

      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("pr", 601), lowRiskJev]]);
      const results = prioritizePullRequests([pr], { jevDecisionsByKey: jevMap });
      const p = results[0];

      expect(p.escalateToGlm).toBe(true);
      expect(p.prSpecific.isLargeUnverifiedDiff).toBe(true);
      expect(p.escalationReasons.some((r) => r.startsWith("seriousness_floor:large_or_untested_diff"))).toBe(true);
    });

    it("escalates a 300-line diff PR lacking tests even when Jev assigns negligible risk", () => {
      const pr = createMockPR({
        number: 602,
        additions: 200,
        deletions: 100, // totalDiffLines = 300 (>= 250)
        hasTests: false,
      });

      const lowRiskJev = createMockJevDecision(pr, {
        security_vulnerability_risk: { type: "noul", noul: 0.01 },
      });

      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("pr", 602), lowRiskJev]]);
      const results = prioritizePullRequests([pr], { jevDecisionsByKey: jevMap });
      const p = results[0];

      expect(p.escalateToGlm).toBe(true);
      expect(p.prSpecific.isLargeUnverifiedDiff).toBe(true);
      expect(p.escalationReasons.some((r) => r.includes("seriousness_floor:large_or_untested_diff"))).toBe(true);
    });

    it("does NOT trigger diff floor escalation for routine documentation PRs with large diffs", () => {
      const docPR = createMockPR({
        number: 603,
        additions: 500,
        deletions: 200, // 700 lines of docs
      });

      const docJev = createMockJevDecision(docPR, {
        category: {
          type: "choice",
          choice: "documentation",
          confidence: 0.98,
          probabilities: { documentation: 0.98 },
        },
        security_vulnerability_risk: { type: "noul", noul: 0.0 },
        needs_deep_review: { type: "noul", noul: 0.0 },
      });

      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("pr", 603), docJev]]);
      const results = prioritizePullRequests([docPR], { jevDecisionsByKey: jevMap });
      const p = results[0];

      expect(p.prSpecific.isLargeUnverifiedDiff).toBe(false);
      expect(p.escalationReasons.some((r) => r.includes("seriousness_floor:large_or_untested_diff"))).toBe(false);
    });

    it("escalates borderline safety risk (0.28) combined with failing CI", () => {
      const pr = createMockPR({
        number: 604,
        ciStatus: "failure",
        additions: 50,
        deletions: 10,
      });

      // Borderline safety risk 0.28
      const borderlineJev = createMockJevDecision(pr, {
        security_vulnerability_risk: { type: "noul", noul: 0.28 },
      });

      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("pr", 604), borderlineJev]]);
      const results = prioritizePullRequests([pr], { jevDecisionsByKey: jevMap });
      const p = results[0];

      expect(p.escalateToGlm).toBe(true);
      expect(p.escalationReasons.some((r) => r.startsWith("seriousness_floor:borderline_safety_with_impact"))).toBe(
        true,
      );
    });

    it("fails closed to escalation when Jev decision is unavailable", () => {
      const pr = createMockPR({ number: 605 });
      const issue = createMockIssue({ number: 606 });

      const prResults = prioritizePullRequests([pr], { jevDecisionsByKey: new Map() });
      const issueResults = prioritizeIssues([issue], { jevDecisionsByKey: new Map() });

      expect(prResults[0].escalateToGlm).toBe(true);
      expect(prResults[0].jevFeatures.available).toBe(false);
      expect(prResults[0].escalationReasons).toContain("seriousness_floor:jev_decision_unavailable");

      expect(issueResults[0].escalateToGlm).toBe(true);
      expect(issueResults[0].jevFeatures.available).toBe(false);
      expect(issueResults[0].escalationReasons).toContain("seriousness_floor:jev_decision_unavailable");
    });

    it("escalates code PR with empty body description", () => {
      const pr = createMockPR({ number: 607, body: "" });
      const jev = createMockJevDecision(pr);
      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("pr", 607), jev]]);

      const results = prioritizePullRequests([pr], { jevDecisionsByKey: jevMap });
      expect(results[0].escalateToGlm).toBe(true);
      expect(results[0].escalationReasons).toContain("seriousness_floor:empty_pr_description");
    });

    it("escalates issue with borderline safety risk and severe production impact", () => {
      const issue = createMockIssue({ number: 608 });
      const borderlineJev = createMockJevDecision(issue, {
        security_vulnerability_risk: { type: "noul", noul: 0.28 },
        production_impact: {
          type: "score",
          score: 2, // Severe (norm = 1.0 >= 0.55)
          confidence: 0.9,
          probabilities: { "2": 0.9 },
        },
      });

      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("issue", 608), borderlineJev]]);
      const results = prioritizeIssues([issue], { jevDecisionsByKey: jevMap });
      const itm = results[0];

      expect(itm.escalateToGlm).toBe(true);
      expect(
        itm.escalationReasons.some((r) => r.startsWith("seriousness_floor:borderline_safety_with_severe_impact")),
      ).toBe(true);
    });

    it("escalates bug issue with severe production impact even if priority score is moderate", () => {
      const issue = createMockIssue({ number: 609 });
      const bugJev = createMockJevDecision(issue, {
        category: {
          type: "choice",
          choice: "bug",
          confidence: 0.9,
          probabilities: { bug: 0.9 },
        },
        operational_priority: {
          type: "score",
          score: 1, // Medium
          confidence: 0.9,
          probabilities: { "1": 0.9 },
        },
        production_impact: {
          type: "score",
          score: 2, // Severe production impact (norm = 1.0 >= 0.85)
          confidence: 0.95,
          probabilities: { "2": 0.95 },
        },
      });

      const jevMap = new Map<string, JevFirstDecisionRecord>([[makeItemKey("issue", 609), bugJev]]);
      const results = prioritizeIssues([issue], { jevDecisionsByKey: jevMap });
      const itm = results[0];

      expect(itm.escalateToGlm).toBe(true);
      expect(itm.escalationReasons.some((r) => r.startsWith("seriousness_floor:severe_production_impact"))).toBe(true);
    });
  });

  describe("Requirement 4: Deterministic Reproducible Escalation Queue", () => {
    it("is 100% deterministic across repeated calls with identical outputs", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
      try {
        const items: PRItem[] = [
          createMockPR({ number: 1, title: "Critical security patch", labels: ["security"] }),
          createMockPR({ number: 2, title: "Normal feature work", additions: 80, deletions: 20 }),
          createMockPR({ number: 3, title: "Large 800 line refactor", additions: 600, deletions: 200 }),
          createMockIssue({ number: 10, title: "Urgent crash on boot", labels: ["p0"] }),
          createMockIssue({ number: 11, title: "Documentation typo in guide" }),
        ];

        const jevDecisionsByKey = new Map<string, JevFirstDecisionRecord>();
        for (const item of items) {
          jevDecisionsByKey.set(makeItemKey(item.type, item.number), createMockJevDecision(item));
        }

        const options = {
          items,
          jevDecisionsByKey,
          generatedAt: "2026-10-27T12:00:00Z",
        };

        const queue1 = buildReproducibleEscalationQueue(options);
        const queue2 = buildReproducibleEscalationQueue(options);

        // Byte-for-byte deterministic serialization
        expect(JSON.stringify(queue1)).toBe(JSON.stringify(queue2));
        expect(queue1.summary).toEqual(queue2.summary);
        expect(queue1.combinedEscalationQueue).toEqual(queue2.combinedEscalationQueue);
      } finally {
        vi.useRealTimers();
      }
    });

    it("properly structures prEscalationQueue, issueEscalationQueue, and combinedEscalationQueue", () => {
      const criticalPR = createMockPR({
        number: 100,
        title: "CVE fix",
        labels: ["security"],
      });
      const routinePR = createMockPR({
        number: 101,
        title: "Documentation update",
        additions: 10,
        deletions: 5,
      });
      const routineDocJev = createMockJevDecision(routinePR, {
        category: { type: "choice", choice: "documentation", confidence: 1.0, probabilities: { documentation: 1.0 } },
        operational_priority: { type: "score", score: 0, confidence: 1.0, probabilities: { "0": 1.0 } },
        production_impact: { type: "score", score: 0, confidence: 1.0, probabilities: { "0": 1.0 } },
        security_vulnerability_risk: { type: "noul", noul: 0.0 },
        needs_deep_review: { type: "noul", noul: 0.0 },
      });

      const highIssue = createMockIssue({
        number: 200,
        title: "P0 release blocker crash",
        labels: ["p0"],
      });
      const routineIssue = createMockIssue({
        number: 201,
        title: "Minor CSS alignment issue",
      });
      const routineIssueJev = createMockJevDecision(routineIssue, {
        category: { type: "choice", choice: "documentation", confidence: 1.0, probabilities: { documentation: 1.0 } },
        operational_priority: { type: "score", score: 0, confidence: 1.0, probabilities: { "0": 1.0 } },
        production_impact: { type: "score", score: 0, confidence: 1.0, probabilities: { "0": 1.0 } },
        security_vulnerability_risk: { type: "noul", noul: 0.0 },
        needs_deep_review: { type: "noul", noul: 0.0 },
      });

      const jevMap = new Map<string, JevFirstDecisionRecord>([
        [makeItemKey("pr", 100), createMockJevDecision(criticalPR)],
        [makeItemKey("pr", 101), routineDocJev],
        [makeItemKey("issue", 200), createMockJevDecision(highIssue)],
        [makeItemKey("issue", 201), routineIssueJev],
      ]);

      const queue = buildReproducibleEscalationQueue({
        items: [criticalPR, routinePR, highIssue, routineIssue],
        jevDecisionsByKey: jevMap,
      });

      // Summary checks
      expect(queue.summary.totalOpenItems).toBe(4);
      expect(queue.summary.totalOpenPRs).toBe(2);
      expect(queue.summary.totalOpenIssues).toBe(2);
      expect(queue.summary.escalatedPRs).toBe(1); // PR 100 escalated
      expect(queue.summary.localOnlyPRs).toBe(1); // PR 101 routine local
      expect(queue.summary.escalatedIssues).toBe(1); // Issue 200 escalated
      expect(queue.summary.localOnlyIssues).toBe(1); // Issue 201 routine local
      expect(queue.summary.totalEscalated).toBe(2);

      // Queue entries
      expect(queue.prEscalationQueue).toHaveLength(1);
      expect(queue.prEscalationQueue[0].number).toBe(100);
      expect(queue.prEscalationQueue[0].rank).toBe(1);
      expect(queue.prEscalationQueue[0].itemTypeRank).toBe(1);

      expect(queue.issueEscalationQueue).toHaveLength(1);
      expect(queue.issueEscalationQueue[0].number).toBe(200);
      expect(queue.issueEscalationQueue[0].rank).toBe(1);
      expect(queue.issueEscalationQueue[0].itemTypeRank).toBe(1);

      // Combined escalation queue
      expect(queue.combinedEscalationQueue).toHaveLength(2);
      expect(queue.combinedEscalationQueue[0].rank).toBe(1);
      expect(queue.combinedEscalationQueue[1].rank).toBe(2);

      // Both escalated items belong to P0_CRITICAL
      expect(queue.combinedEscalationQueue[0].escalationBand).toBe("P0_CRITICAL");
      expect(queue.combinedEscalationQueue[1].escalationBand).toBe("P0_CRITICAL");
    });

    it("correctly enforces escalation band order (P0_CRITICAL before P1_HIGH before P2_MODERATE)", () => {
      const p0PR = createMockPR({ number: 1, title: "P0 Blocker", labels: ["p0"] });
      const p1PR = createMockPR({
        number: 2,
        title: "High priority feature",
        additions: 100,
        deletions: 50,
      });
      const p1Jev = createMockJevDecision(p1PR, {
        operational_priority: { type: "score", score: 2, confidence: 0.9, probabilities: { "2": 0.9 } }, // high
        needs_deep_review: { type: "noul", noul: 0.6 },
      });

      const p2PR = createMockPR({
        number: 3,
        title: "Moderate complexity PR without tests",
        additions: 260,
        deletions: 20, // diff floor triggers P2
        hasTests: false,
      });
      const p2Jev = createMockJevDecision(p2PR, {
        operational_priority: { type: "score", score: 0, confidence: 0.9, probabilities: { "0": 0.9 } },
        needs_deep_review: { type: "noul", noul: 0.1 },
      });

      const jevMap = new Map<string, JevFirstDecisionRecord>([
        [makeItemKey("pr", 1), createMockJevDecision(p0PR)],
        [makeItemKey("pr", 2), p1Jev],
        [makeItemKey("pr", 3), p2Jev],
      ]);

      const queue = buildReproducibleEscalationQueue({
        items: [p2PR, p0PR, p1PR], // Pass in scrambled order
        jevDecisionsByKey: jevMap,
      });

      expect(queue.prEscalationQueue).toHaveLength(3);
      expect(queue.prEscalationQueue[0].number).toBe(1);
      expect(queue.prEscalationQueue[0].escalationBand).toBe("P0_CRITICAL");
      expect(queue.prEscalationQueue[1].number).toBe(2);
      expect(queue.prEscalationQueue[1].escalationBand).toBe("P1_HIGH");
      expect(queue.prEscalationQueue[2].number).toBe(3);
      expect(queue.prEscalationQueue[2].escalationBand).toBe("P2_MODERATE");
    });
  });
});
