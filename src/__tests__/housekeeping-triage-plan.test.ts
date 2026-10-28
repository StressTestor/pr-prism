import { describe, expect, it } from "vitest";
import {
  buildTriagePlan,
  exportTriagePlanJson,
  mapToTriageActionGroup,
  REVIEW_CALL_AVOIDANCE_NOTE,
  TRIAGE_ACTION_GROUP_ORDER,
  TRIAGE_PLAN_SCHEMA_VERSION,
  TRIAGE_SCHEDULER_CONTRACT_VERSION,
  type TriageActionGroup,
  type TriagePlan,
  type TriagePlanEntry,
  type TriagePlanInputEntry,
} from "../housekeeping/triage-plan.js";
import type { PRItem } from "../types.js";

function createMockItem(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 1,
    type: "pr",
    repo: "owner/repo",
    title: "Mock item",
    body: "Mock description",
    state: "open",
    author: "contributor",
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
    labels: [],
    ...overrides,
  };
}

describe("Task E — Housekeeping Triage Plan Module", () => {
  // ── TEST 1: Priority ordering ─────────────────────────────────────────────
  it("enforces strict priority ordering across all triage action groups", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 7, title: "Ready for maintainer item" }),
        actionSignal: "READY_FOR_MAINTAINER",
        actionReasons: ["default triage"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 3, title: "Light review item" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["small change"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 1, title: "Closure candidate item" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["duplicate of #99"],
        calibratedBand: "P2",
        closureCandidateVerified: true,
        closureCandidateEvidenceNote: "Exact patch match",
      },
      {
        item: createMockItem({ number: 6, title: "Maintainer decision item" }),
        actionSignal: "MAINTAINER_DECISION",
        actionReasons: ["policy review"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 5, title: "Complex review item" }),
        actionSignal: "COMPLEX_REVIEW_NEEDED",
        actionReasons: ["architecture refactor"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 2, title: "Information request item" }),
        actionSignal: "REQUEST_INFORMATION",
        actionReasons: ["needs reproduction"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 4, title: "Intermediate review item" }),
        actionSignal: "INTERMEDIATE_REVIEW",
        actionReasons: ["moderate complexity"],
        calibratedBand: "P2",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");
    const orderedGroups = plan.entries.map((e) => e.actionGroup);

    expect(orderedGroups).toEqual([
      "CLOSURE_CANDIDATES",
      "INFORMATION_REQUESTS",
      "LIGHT_REVIEW",
      "INTERMEDIATE_REVIEW",
      "COMPLEX_REVIEW_NEEDED",
      "MAINTAINER_DECISION",
      "READY_FOR_MAINTAINER",
    ]);

    // Matches the exported TRIAGE_ACTION_GROUP_ORDER
    expect(orderedGroups).toEqual([...TRIAGE_ACTION_GROUP_ORDER]);
  });

  // ── TEST 2: estimatedReviewCallAvoided only for verified closure candidates ─
  it("sets estimatedReviewCallAvoided = true ONLY for verified closure candidates", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 101, title: "Verified closure candidate" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["confirmed identical patch"],
        calibratedBand: "P0",
        closureCandidateVerified: true,
        closureCandidateEvidenceNote: "Identical patch SHA-256",
      },
      {
        item: createMockItem({ number: 102, title: "Unverified closure candidate (false)" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["possible similarity"],
        calibratedBand: "P0",
        closureCandidateVerified: false,
        closureCandidateEvidenceNote: "Not verified yet",
      },
      {
        item: createMockItem({ number: 103, title: "Unverified closure candidate (omitted)" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["text resemblance"],
        calibratedBand: "P0",
      },
      {
        item: createMockItem({ number: 104, title: "Light review with verified flag accidentally true" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["doc fix"],
        calibratedBand: "P2",
        closureCandidateVerified: true,
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");

    const verifiedClosure = plan.entries.find((e) => e.number === 101)!;
    expect(verifiedClosure.estimatedReviewCallAvoided).toBe(true);
    expect(verifiedClosure.evidenceForAvoidance).toBe("Identical patch SHA-256");

    const unverifiedFalse = plan.entries.find((e) => e.number === 102)!;
    expect(unverifiedFalse.estimatedReviewCallAvoided).toBe(false);
    expect(unverifiedFalse.evidenceForAvoidance).toBeUndefined();

    const unverifiedOmitted = plan.entries.find((e) => e.number === 103)!;
    expect(unverifiedOmitted.estimatedReviewCallAvoided).toBe(false);
    expect(unverifiedOmitted.evidenceForAvoidance).toBeUndefined();

    const lightReview = plan.entries.find((e) => e.number === 104)!;
    expect(lightReview.estimatedReviewCallAvoided).toBe(false);
    expect(lightReview.evidenceForAvoidance).toBeUndefined();

    expect(plan.summary.estimatedReviewCallsAvoided).toBe(1);
  });

  // ── TEST 3: Review call avoidance note ────────────────────────────────────
  it("includes required disclaimer note mentioning deterministic verification evidence", () => {
    const plan = buildTriagePlan([], "owner/repo");
    expect(plan.summary.reviewCallAvoidanceNote).toBe(REVIEW_CALL_AVOIDANCE_NOTE);
    expect(plan.summary.reviewCallAvoidanceNote).toContain("deterministic verification evidence");
    expect(plan.summary.reviewCallAvoidanceNote).toContain("Unverified closure candidates are not counted");
  });

  // ── TEST 4: COMPLEX_REVIEW_NEEDED does NOT bind to specific LLM ────────────
  it("ensures COMPLEX_REVIEW_NEEDED does not bind to any specific LLM provider or model", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 50, title: "High complexity PR" }),
        actionSignal: "COMPLEX_REVIEW_NEEDED",
        actionReasons: ["multi-file subsystem redesign"],
        calibratedBand: "P1_HIGH_REVIEW",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");
    const entry: TriagePlanEntry = plan.entries[0];

    expect(entry.actionGroup).toBe("COMPLEX_REVIEW_NEEDED");
    // Verify entry is purely routing metadata without LLM bindings
    const rawEntry = entry as unknown as Record<string, unknown>;
    expect(rawEntry.model).toBeUndefined();
    expect(rawEntry.llmProvider).toBeUndefined();
    expect(rawEntry.glm).toBeUndefined();
    expect(rawEntry.targetModel).toBeUndefined();
  });

  // ── TEST 5: PR before issue tie-break ────────────────────────────────────
  it("breaks ties by placing PR items before issue items within the same group and band", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 10, type: "issue", title: "Issue item #10" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["minor docs"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 99, type: "pr", title: "PR item #99" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["minor docs fix"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 5, type: "issue", title: "Issue item #5" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["small tweak"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 20, type: "pr", title: "PR item #20" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["small tweak fix"],
        calibratedBand: "P2",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");

    // PRs must precede issues; then item number ascending
    expect(plan.entries.map((e) => `${e.itemType}#${e.number}`)).toEqual(["pr#20", "pr#99", "issue#5", "issue#10"]);
  });

  // ── TEST 6: Rank is consecutive and starts at 1 ──────────────────────────
  it("assigns consecutive 1-indexed ranks starting at 1", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 30 }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["reason"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 10 }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["reason"],
        calibratedBand: "P0",
      },
      {
        item: createMockItem({ number: 20 }),
        actionSignal: "REQUEST_INFORMATION",
        actionReasons: ["reason"],
        calibratedBand: "P1",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");

    expect(plan.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  // ── TEST 7: requiresMaintainerApproval always true ────────────────────────
  it("enforces requiresMaintainerApproval = true for every entry across all groups", () => {
    const inputEntries: TriagePlanInputEntry[] = TRIAGE_ACTION_GROUP_ORDER.map((group, idx) => ({
      item: createMockItem({ number: idx + 1 }),
      actionSignal: group,
      actionReasons: [`reason for ${group}`],
      calibratedBand: "P1",
      closureCandidateVerified: group === "CLOSURE_CANDIDATES",
    }));

    const plan = buildTriagePlan(inputEntries, "owner/repo");

    for (const entry of plan.entries) {
      expect(entry.requiresMaintainerApproval).toBe(true);
    }
  });

  // ── TEST 8: byItemType counts ─────────────────────────────────────────────
  it("accurately computes separate PR and issue counts per action group", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 1, type: "pr" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["dupe"],
        calibratedBand: "P0",
        closureCandidateVerified: true,
      },
      {
        item: createMockItem({ number: 2, type: "issue" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["resolved in #10"],
        calibratedBand: "P0",
        closureCandidateVerified: true,
      },
      {
        item: createMockItem({ number: 3, type: "pr" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["doc"],
        calibratedBand: "P3",
      },
      {
        item: createMockItem({ number: 4, type: "pr" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["style"],
        calibratedBand: "P3",
      },
      {
        item: createMockItem({ number: 5, type: "issue" }),
        actionSignal: "REQUEST_INFORMATION",
        actionReasons: ["repro needed"],
        calibratedBand: "P1",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");

    expect(plan.summary.totalItems).toBe(5);
    expect(plan.summary.totalPRs).toBe(3);
    expect(plan.summary.totalIssues).toBe(2);

    expect(plan.summary.byItemType.pr.CLOSURE_CANDIDATES).toBe(1);
    expect(plan.summary.byItemType.issue.CLOSURE_CANDIDATES).toBe(1);
    expect(plan.summary.closureCandidates).toBe(2);

    expect(plan.summary.byItemType.pr.LIGHT_REVIEW).toBe(2);
    expect(plan.summary.byItemType.issue.LIGHT_REVIEW).toBe(0);
    expect(plan.summary.lightReviews).toBe(2);

    expect(plan.summary.byItemType.pr.INFORMATION_REQUESTS).toBe(0);
    expect(plan.summary.byItemType.issue.INFORMATION_REQUESTS).toBe(1);
    expect(plan.summary.informationRequests).toBe(1);

    expect(plan.summary.intermediateReviews).toBe(0);
    expect(plan.summary.complexReviewsNeeded).toBe(0);
    expect(plan.summary.maintainerDecisions).toBe(0);
    expect(plan.summary.readyForMaintainer).toBe(0);
  });

  // ── TEST 9: exportTriagePlanJson produces valid JSON that round-trips ─────
  it("serializes to valid JSON and successfully round-trips with deep equality", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 42, title: "Fix retry backoff" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["Duplicate of #20"],
        calibratedBand: "P0_OPERATIONAL_CRITICAL",
        closureCandidateVerified: true,
        closureCandidateEvidenceNote: "Same git commit OID",
      },
      {
        item: createMockItem({ number: 43, type: "issue", title: "Crash on startup" }),
        actionSignal: "MAINTAINER_DECISION",
        actionReasons: ["Security implication"],
        calibratedBand: "P0_SECURITY_CRITICAL",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo", {
      generatedAt: "2026-10-27T12:00:00.000Z",
    });

    const json = exportTriagePlanJson(plan);
    expect(typeof json).toBe("string");

    const parsed = JSON.parse(json) as TriagePlan;
    expect(parsed).toEqual(plan);
    expect(parsed.schemaVersion).toBe(TRIAGE_PLAN_SCHEMA_VERSION);
    expect(parsed.schedulerContractVersion).toBe(TRIAGE_SCHEDULER_CONTRACT_VERSION);
  });

  // ── TEST 10: mapToTriageActionGroup correctly maps all expected signals/routes
  it("maps all expected resolution action signals and advisory routes correctly", () => {
    const testCases: Array<{ signal: string; expected: TriageActionGroup }> = [
      // Direct action signals
      { signal: "CLOSE_CANDIDATE", expected: "CLOSURE_CANDIDATES" },
      { signal: "CLOSURE_CANDIDATES", expected: "CLOSURE_CANDIDATES" },
      { signal: "REQUEST_INFORMATION", expected: "INFORMATION_REQUESTS" },
      { signal: "INFORMATION_REQUESTS", expected: "INFORMATION_REQUESTS" },
      { signal: "LIGHT_REVIEW", expected: "LIGHT_REVIEW" },
      { signal: "INTERMEDIATE_REVIEW", expected: "INTERMEDIATE_REVIEW" },
      { signal: "COMPLEX_REVIEW_NEEDED", expected: "COMPLEX_REVIEW_NEEDED" },
      { signal: "MAINTAINER_DECISION", expected: "MAINTAINER_DECISION" },
      { signal: "READY_FOR_MAINTAINER", expected: "READY_FOR_MAINTAINER" },

      // Advisory routes
      { signal: "routine_review", expected: "LIGHT_REVIEW" },
      { signal: "expert_investigation", expected: "COMPLEX_REVIEW_NEEDED" },
      { signal: "security_escalation", expected: "MAINTAINER_DECISION" },
      { signal: "needs_reproduction", expected: "INFORMATION_REQUESTS" },
      { signal: "documentation_only", expected: "LIGHT_REVIEW" },
      { signal: "maintainer_triage", expected: "READY_FOR_MAINTAINER" },

      // Normalized casing
      { signal: "close_candidate", expected: "CLOSURE_CANDIDATES" },
      { signal: "request_information", expected: "INFORMATION_REQUESTS" },
      { signal: "light_review", expected: "LIGHT_REVIEW" },
      { signal: "intermediate_review", expected: "INTERMEDIATE_REVIEW" },
      { signal: "complex_review_needed", expected: "COMPLEX_REVIEW_NEEDED" },
      { signal: "maintainer_decision", expected: "MAINTAINER_DECISION" },
      { signal: "ready_for_maintainer", expected: "READY_FOR_MAINTAINER" },
    ];

    for (const { signal, expected } of testCases) {
      expect(mapToTriageActionGroup(signal)).toBe(expected);
    }
  });

  // ── TEST 11: Unknown signal maps to READY_FOR_MAINTAINER ─────────────────
  it("gracefully maps unknown signals to READY_FOR_MAINTAINER without throwing", () => {
    expect(mapToTriageActionGroup("unknown_action")).toBe("READY_FOR_MAINTAINER");
    expect(mapToTriageActionGroup("arbitrary_string")).toBe("READY_FOR_MAINTAINER");
    expect(mapToTriageActionGroup("")).toBe("READY_FOR_MAINTAINER");
    expect(mapToTriageActionGroup("   ")).toBe("READY_FOR_MAINTAINER");
    expect(mapToTriageActionGroup(null as unknown as string)).toBe("READY_FOR_MAINTAINER");
    expect(mapToTriageActionGroup(undefined as unknown as string)).toBe("READY_FOR_MAINTAINER");
  });

  // ── TEST 12: Summary totals match entries length ─────────────────────────
  it("ensures summary totals match the exact number of entries and breakdown", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 1, type: "pr" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["dupe"],
        calibratedBand: "P0",
      },
      {
        item: createMockItem({ number: 2, type: "pr" }),
        actionSignal: "REQUEST_INFORMATION",
        actionReasons: ["info"],
        calibratedBand: "P1",
      },
      {
        item: createMockItem({ number: 3, type: "issue" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["doc"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 4, type: "issue" }),
        actionSignal: "INTERMEDIATE_REVIEW",
        actionReasons: ["moderate"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 5, type: "pr" }),
        actionSignal: "COMPLEX_REVIEW_NEEDED",
        actionReasons: ["complex"],
        calibratedBand: "P1",
      },
      {
        item: createMockItem({ number: 6, type: "issue" }),
        actionSignal: "MAINTAINER_DECISION",
        actionReasons: ["decision"],
        calibratedBand: "P0",
      },
      {
        item: createMockItem({ number: 7, type: "pr" }),
        actionSignal: "READY_FOR_MAINTAINER",
        actionReasons: ["ready"],
        calibratedBand: "P3",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");
    const summary = plan.summary;

    expect(summary.totalItems).toBe(inputEntries.length);
    expect(summary.totalPRs).toBe(4);
    expect(summary.totalIssues).toBe(3);
    expect(summary.totalPRs + summary.totalIssues).toBe(summary.totalItems);

    const sumOfGroups =
      summary.closureCandidates +
      summary.informationRequests +
      summary.lightReviews +
      summary.intermediateReviews +
      summary.complexReviewsNeeded +
      summary.maintainerDecisions +
      summary.readyForMaintainer;

    expect(sumOfGroups).toBe(summary.totalItems);
  });

  // ── TEST 13: Empty input produces valid plan with zero counts ───────────
  it("handles empty input producing a valid plan with zero counts", () => {
    const plan = buildTriagePlan([], "owner/repo", {
      generatedAt: "2026-10-27T00:00:00.000Z",
    });

    expect(plan.schemaVersion).toBe(TRIAGE_PLAN_SCHEMA_VERSION);
    expect(plan.schedulerContractVersion).toBe(TRIAGE_SCHEDULER_CONTRACT_VERSION);
    expect(plan.repo).toBe("owner/repo");
    expect(plan.generatedAt).toBe("2026-10-27T00:00:00.000Z");
    expect(plan.entries).toEqual([]);

    expect(plan.summary).toEqual({
      schemaVersion: TRIAGE_PLAN_SCHEMA_VERSION,
      generatedAt: "2026-10-27T00:00:00.000Z",
      repo: "owner/repo",
      totalItems: 0,
      totalPRs: 0,
      totalIssues: 0,
      closureCandidates: 0,
      informationRequests: 0,
      lightReviews: 0,
      intermediateReviews: 0,
      complexReviewsNeeded: 0,
      maintainerDecisions: 0,
      readyForMaintainer: 0,
      estimatedReviewCallsAvoided: 0,
      reviewCallAvoidanceNote: REVIEW_CALL_AVOIDANCE_NOTE,
      byItemType: {
        pr: {
          CLOSURE_CANDIDATES: 0,
          INFORMATION_REQUESTS: 0,
          LIGHT_REVIEW: 0,
          INTERMEDIATE_REVIEW: 0,
          COMPLEX_REVIEW_NEEDED: 0,
          MAINTAINER_DECISION: 0,
          READY_FOR_MAINTAINER: 0,
        },
        issue: {
          CLOSURE_CANDIDATES: 0,
          INFORMATION_REQUESTS: 0,
          LIGHT_REVIEW: 0,
          INTERMEDIATE_REVIEW: 0,
          COMPLEX_REVIEW_NEEDED: 0,
          MAINTAINER_DECISION: 0,
          READY_FOR_MAINTAINER: 0,
        },
      },
    });
  });

  // ── TEST 14: Negative: unverified closure candidate ───────────────────────
  it("negative: unverified closure candidate has estimatedReviewCallAvoided = false and evidenceForAvoidance absent", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 999, title: "Unverified candidate with note" }),
        actionSignal: "CLOSE_CANDIDATE",
        actionReasons: ["Heuristic text similarity only"],
        calibratedBand: "P2",
        closureCandidateVerified: false,
        closureCandidateEvidenceNote: "Heuristic match 78% — needs verification",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");
    const entry: TriagePlanEntry = plan.entries[0];

    expect(entry.actionGroup).toBe("CLOSURE_CANDIDATES");
    expect(entry.closureCandidateVerified).toBe(false);
    expect(entry.estimatedReviewCallAvoided).toBe(false);
    expect(entry.evidenceForAvoidance).toBeUndefined();
    expect("evidenceForAvoidance" in entry).toBe(false);

    expect(plan.summary.closureCandidates).toBe(1);
    expect(plan.summary.estimatedReviewCallsAvoided).toBe(0);
  });

  // ── TEST 15: Calibrated priority band sorting ─────────────────────────────
  it("sorts by calibrated band (P0 before P1 before P2 before P3 before P4) within same action group", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 3 }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["r3"],
        calibratedBand: "P3_LIGHT_REVIEW",
      },
      {
        item: createMockItem({ number: 0 }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["r0"],
        calibratedBand: "P0_OPERATIONAL_CRITICAL",
      },
      {
        item: createMockItem({ number: 2 }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["r2"],
        calibratedBand: "P2_INTERMEDIATE_REVIEW",
      },
      {
        item: createMockItem({ number: 1 }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["r1"],
        calibratedBand: "P1_HIGH_REVIEW",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");
    expect(plan.entries.map((e) => e.number)).toEqual([0, 1, 2, 3]);
  });

  // ── TEST 16: Ascending item number tie-break ─────────────────────────────
  it("breaks ties by ascending item number when group, band, and itemType are identical", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 50, type: "pr" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["r"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 12, type: "pr" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["r"],
        calibratedBand: "P2",
      },
      {
        item: createMockItem({ number: 35, type: "pr" }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["r"],
        calibratedBand: "P2",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");
    expect(plan.entries.map((e) => e.number)).toEqual([12, 35, 50]);
  });

  // ── TEST 17: closureCandidateVerified only present for CLOSURE_CANDIDATES ──
  it("does not attach closureCandidateVerified property to non-closure action groups", () => {
    const inputEntries: TriagePlanInputEntry[] = [
      {
        item: createMockItem({ number: 1 }),
        actionSignal: "LIGHT_REVIEW",
        actionReasons: ["r"],
        calibratedBand: "P2",
        closureCandidateVerified: true, // Should not leak onto planEntry
      },
      {
        item: createMockItem({ number: 2 }),
        actionSignal: "MAINTAINER_DECISION",
        actionReasons: ["r"],
        calibratedBand: "P1",
      },
    ];

    const plan = buildTriagePlan(inputEntries, "owner/repo");

    for (const entry of plan.entries) {
      expect(entry.closureCandidateVerified).toBeUndefined();
      expect("closureCandidateVerified" in entry).toBe(false);
    }
  });
});
