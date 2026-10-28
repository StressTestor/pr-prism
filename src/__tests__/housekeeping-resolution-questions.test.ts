import { describe, expect, it } from "vitest";
import { evaluateDeterministicSafetyGates } from "../decisions/triage-v2.js";
import type { DecisionProvenance } from "../decisions/types.js";
import {
  deriveResolutionAction,
  RESOLUTION_QUESTIONS,
  RESOLUTION_QUESTIONS_RUBRIC_VERSION,
  RESOLUTION_QUESTIONS_SCHEMA_VERSION,
  type ResolutionActionSignal,
  type ResolutionDecisionRecord,
  type ResolutionQuestionKey,
} from "../housekeeping/resolution-questions.js";
import type { PRItem } from "../types.js";

function createMockItem(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 42,
    type: "pr",
    repo: "owner/repo",
    title: "Update styling on user dashboard",
    body: "Refactor CSS modules to use tokens.",
    state: "open",
    author: "contributor",
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
    labels: [],
    ...overrides,
  };
}

function createMockProvenance(): DecisionProvenance {
  return {
    provider: "jev",
    model: "jev-1.14.0",
    inputHash: "a".repeat(64),
    decisionSchemaVersion: "1.0.0",
    rubricHash: "b".repeat(64),
    decisionIdentity: "c".repeat(64),
    evaluatedAt: new Date().toISOString(),
  };
}

describe("Housekeeping Jev Typed Resolution Questions", () => {
  describe("Requirement 1: Schema Constants", () => {
    it("exports RESOLUTION_QUESTIONS_SCHEMA_VERSION as 1.0.0", () => {
      expect(RESOLUTION_QUESTIONS_SCHEMA_VERSION).toBe("1.0.0");
    });

    it("exports RESOLUTION_QUESTIONS_RUBRIC_VERSION as v1", () => {
      expect(RESOLUTION_QUESTIONS_RUBRIC_VERSION).toBe("v1");
    });
  });

  describe("Requirement 7 & 8: Typed Question Catalog & Structure", () => {
    it("contains exactly the 9 expected question keys", () => {
      const expectedKeys: ResolutionQuestionKey[] = [
        "actionable",
        "already_resolved_candidate",
        "code_review_complexity",
        "current_project_relevance",
        "duplicate_candidate",
        "human_decision_required",
        "missing_information",
        "same_underlying_problem",
        "superseded_candidate",
      ];

      const actualKeys = Object.keys(RESOLUTION_QUESTIONS).sort();
      expect(actualKeys).toHaveLength(9);
      expect(actualKeys).toEqual(expectedKeys.sort());
    });

    it("assigns the correct primitive type (noul or score) to each question", () => {
      expect(RESOLUTION_QUESTIONS.same_underlying_problem.type).toBe("noul");
      expect(RESOLUTION_QUESTIONS.duplicate_candidate.type).toBe("noul");
      expect(RESOLUTION_QUESTIONS.already_resolved_candidate.type).toBe("noul");
      expect(RESOLUTION_QUESTIONS.superseded_candidate.type).toBe("noul");
      expect(RESOLUTION_QUESTIONS.missing_information.type).toBe("noul");
      expect(RESOLUTION_QUESTIONS.actionable.type).toBe("noul");
      expect(RESOLUTION_QUESTIONS.current_project_relevance.type).toBe("score");
      expect(RESOLUTION_QUESTIONS.code_review_complexity.type).toBe("score");
      expect(RESOLUTION_QUESTIONS.human_decision_required.type).toBe("noul");
    });

    it("includes comprehensive instructions and valid criteria for all noul questions", () => {
      const noulKeys: ResolutionQuestionKey[] = [
        "same_underlying_problem",
        "duplicate_candidate",
        "already_resolved_candidate",
        "superseded_candidate",
        "missing_information",
        "actionable",
        "human_decision_required",
      ];

      for (const key of noulKeys) {
        const q = RESOLUTION_QUESTIONS[key];
        expect(q.type).toBe("noul");
        expect(typeof q.instructions).toBe("string");
        expect(q.instructions.length).toBeGreaterThan(20);
        if (q.type === "noul") {
          expect(q.criteria).toBeDefined();
          expect(typeof q.criteria?.true).toBe("string");
          expect(typeof q.criteria?.false).toBe("string");
        }
      }
    });

    it("includes ordered 0-3 level criteria for score questions", () => {
      const scoreKeys: ResolutionQuestionKey[] = ["current_project_relevance", "code_review_complexity"];

      for (const key of scoreKeys) {
        const q = RESOLUTION_QUESTIONS[key];
        expect(q.type).toBe("score");
        expect(typeof q.instructions).toBe("string");
        if (q.type === "score") {
          expect(Array.isArray(q.criteria)).toBe(true);
          expect(q.criteria).toHaveLength(4); // levels 0, 1, 2, 3
          expect(q.criteria[0]).toMatch(/Level 0/i);
          expect(q.criteria[3]).toMatch(/Level 3/i);
        }
      }
    });

    it("emphasizes complexity != criticality in code_review_complexity instructions", () => {
      expect(RESOLUTION_QUESTIONS.code_review_complexity.instructions).toMatch(
        /complexity is not equal to criticality/i,
      );
    });
  });

  describe("Requirement 2: deriveResolutionAction Deterministic Policy", () => {
    it("Rule 1: safety gate triggered always returns MAINTAINER_DECISION", () => {
      const result = deriveResolutionAction(
        {
          duplicate_candidate: { type: "noul", noul: 0.99 },
          already_resolved_candidate: { type: "noul", noul: 0.99 },
          code_review_complexity: { type: "score", score: 0 },
        },
        "pr",
        "open",
        ["safety_gate:security(cve-2026-1000)"],
      );

      expect(result.signal).toBe("MAINTAINER_DECISION");
      expect(result.requiresHumanApproval).toBe(true);
      expect(result.reasons.some((r) => r.includes("Safety gate triggered"))).toBe(true);
    });

    it("Rule 2: high duplicate (>= 0.8) and already resolved (>= 0.7) produces CLOSE_CANDIDATE", () => {
      const result = deriveResolutionAction(
        {
          duplicate_candidate: { type: "noul", noul: 0.8 },
          already_resolved_candidate: { type: "noul", noul: 0.7 },
        },
        "issue",
        "open",
        [],
      );

      expect(result.signal).toBe("CLOSE_CANDIDATE");
      expect(result.requiresHumanApproval).toBe(true);
      expect(result.reasons.some((r) => r.includes("Duplicate candidate"))).toBe(true);
    });

    it("Rule 2: does not produce CLOSE_CANDIDATE if duplicate < 0.8", () => {
      const result = deriveResolutionAction(
        {
          duplicate_candidate: { type: "noul", noul: 0.79 },
          already_resolved_candidate: { type: "noul", noul: 0.9 },
        },
        "pr",
        "open",
        [],
      );

      expect(result.signal).not.toBe("CLOSE_CANDIDATE");
    });

    it("Rule 2: does not produce CLOSE_CANDIDATE if already_resolved < 0.7", () => {
      const result = deriveResolutionAction(
        {
          duplicate_candidate: { type: "noul", noul: 0.95 },
          already_resolved_candidate: { type: "noul", noul: 0.69 },
        },
        "pr",
        "open",
        [],
      );

      expect(result.signal).not.toBe("CLOSE_CANDIDATE");
    });

    it("Rule 3: high missing_info (>= 0.75) and low actionable (< 0.4) produces REQUEST_INFORMATION", () => {
      const result = deriveResolutionAction(
        {
          missing_information: { type: "noul", noul: 0.75 },
          actionable: { type: "noul", noul: 0.39 },
        },
        "issue",
        "open",
        [],
      );

      expect(result.signal).toBe("REQUEST_INFORMATION");
      expect(result.requiresHumanApproval).toBe(true);
      expect(result.reasons.some((r) => r.includes("Missing information"))).toBe(true);
    });

    it("Rule 3: does not produce REQUEST_INFORMATION if actionable >= 0.4", () => {
      const result = deriveResolutionAction(
        {
          missing_information: { type: "noul", noul: 0.85 },
          actionable: { type: "noul", noul: 0.4 },
        },
        "issue",
        "open",
        [],
      );

      expect(result.signal).not.toBe("REQUEST_INFORMATION");
    });

    it("Rule 3: does not produce REQUEST_INFORMATION if missing_information < 0.75", () => {
      const result = deriveResolutionAction(
        {
          missing_information: { type: "noul", noul: 0.74 },
          actionable: { type: "noul", noul: 0.1 },
        },
        "issue",
        "open",
        [],
      );

      expect(result.signal).not.toBe("REQUEST_INFORMATION");
    });

    it("Rule 4: code_review_complexity == 3 produces COMPLEX_REVIEW_NEEDED", () => {
      const result = deriveResolutionAction(
        {
          code_review_complexity: { type: "score", score: 3 },
          human_decision_required: { type: "noul", noul: 0.2 },
        },
        "pr",
        "open",
        [],
      );

      expect(result.signal).toBe("COMPLEX_REVIEW_NEEDED");
      expect(result.requiresHumanApproval).toBe(true);
      expect(result.reasons.some((r) => r.includes("complex review needed"))).toBe(true);
    });

    it("Rule 5: code_review_complexity == 2 produces INTERMEDIATE_REVIEW", () => {
      const result = deriveResolutionAction(
        {
          code_review_complexity: { type: "score", score: 2 },
          human_decision_required: { type: "noul", noul: 0.1 },
        },
        "pr",
        "open",
        [],
      );

      expect(result.signal).toBe("INTERMEDIATE_REVIEW");
      expect(result.requiresHumanApproval).toBe(true);
      expect(result.reasons.some((r) => r.includes("intermediate review"))).toBe(true);
    });

    it("Rule 6: code_review_complexity <= 1 and human_decision < 0.5 produces LIGHT_REVIEW", () => {
      const resultScore1 = deriveResolutionAction(
        {
          code_review_complexity: { type: "score", score: 1 },
          human_decision_required: { type: "noul", noul: 0.3 },
        },
        "pr",
        "open",
        [],
      );
      expect(resultScore1.signal).toBe("LIGHT_REVIEW");
      expect(resultScore1.requiresHumanApproval).toBe(true);

      const resultScore0 = deriveResolutionAction(
        {
          code_review_complexity: { type: "score", score: 0 },
          human_decision_required: { type: "noul", noul: 0.49 },
        },
        "pr",
        "open",
        [],
      );
      expect(resultScore0.signal).toBe("LIGHT_REVIEW");

      // Also when human_decision_required is not specified
      const resultUnspecifiedHuman = deriveResolutionAction(
        {
          code_review_complexity: { type: "score", score: 1 },
        },
        "pr",
        "open",
        [],
      );
      expect(resultUnspecifiedHuman.signal).toBe("LIGHT_REVIEW");
    });

    it("Rule 7: human_decision_required >= 0.7 produces MAINTAINER_DECISION", () => {
      // Standalone high human decision
      const resultStandalone = deriveResolutionAction(
        {
          human_decision_required: { type: "noul", noul: 0.7 },
        },
        "pr",
        "open",
        [],
      );
      expect(resultStandalone.signal).toBe("MAINTAINER_DECISION");
      expect(resultStandalone.requiresHumanApproval).toBe(true);

      // Low complexity but high human decision (Rule 6 bypassed because noul is not < 0.5)
      const resultWithLowComplexity = deriveResolutionAction(
        {
          code_review_complexity: { type: "score", score: 1 },
          human_decision_required: { type: "noul", noul: 0.8 },
        },
        "pr",
        "open",
        [],
      );
      expect(resultWithLowComplexity.signal).toBe("MAINTAINER_DECISION");
    });

    it("Rule 8: default produces READY_FOR_MAINTAINER when no strong signal triggers", () => {
      // Completely empty answers
      const resultEmpty = deriveResolutionAction({}, "pr", "open", []);
      expect(resultEmpty.signal).toBe("READY_FOR_MAINTAINER");
      expect(resultEmpty.requiresHumanApproval).toBe(true);

      // Moderate non-triggering answers
      const resultModerate = deriveResolutionAction(
        {
          duplicate_candidate: { type: "noul", noul: 0.4 },
          already_resolved_candidate: { type: "noul", noul: 0.3 },
          current_project_relevance: { type: "score", score: 2 },
          actionable: { type: "noul", noul: 0.9 },
          human_decision_required: { type: "noul", noul: 0.3 },
        },
        "pr",
        "open",
        [],
      );
      expect(resultModerate.signal).toBe("READY_FOR_MAINTAINER");
      expect(resultModerate.requiresHumanApproval).toBe(true);
    });
  });

  describe("Requirement 3: requiresHumanApproval is ALWAYS true", () => {
    it("enforces requiresHumanApproval === true across every possible action signal", () => {
      const scenarios: Array<{
        name: string;
        expectedSignal: ResolutionActionSignal;
        action: () => ReturnType<typeof deriveResolutionAction>;
      }> = [
        {
          name: "MAINTAINER_DECISION via safety gate",
          expectedSignal: "MAINTAINER_DECISION",
          action: () => deriveResolutionAction({}, "pr", "open", ["safety_gate:security(auth)"]),
        },
        {
          name: "MAINTAINER_DECISION via human_decision_required",
          expectedSignal: "MAINTAINER_DECISION",
          action: () =>
            deriveResolutionAction({ human_decision_required: { type: "noul", noul: 0.85 } }, "issue", "open", []),
        },
        {
          name: "CLOSE_CANDIDATE via duplicate + resolved",
          expectedSignal: "CLOSE_CANDIDATE",
          action: () =>
            deriveResolutionAction(
              {
                duplicate_candidate: { type: "noul", noul: 0.9 },
                already_resolved_candidate: { type: "noul", noul: 0.8 },
              },
              "pr",
              "open",
              [],
            ),
        },
        {
          name: "REQUEST_INFORMATION via missing info + not actionable",
          expectedSignal: "REQUEST_INFORMATION",
          action: () =>
            deriveResolutionAction(
              {
                missing_information: { type: "noul", noul: 0.8 },
                actionable: { type: "noul", noul: 0.2 },
              },
              "issue",
              "open",
              [],
            ),
        },
        {
          name: "COMPLEX_REVIEW_NEEDED via complexity == 3",
          expectedSignal: "COMPLEX_REVIEW_NEEDED",
          action: () =>
            deriveResolutionAction({ code_review_complexity: { type: "score", score: 3 } }, "pr", "open", []),
        },
        {
          name: "INTERMEDIATE_REVIEW via complexity == 2",
          expectedSignal: "INTERMEDIATE_REVIEW",
          action: () =>
            deriveResolutionAction({ code_review_complexity: { type: "score", score: 2 } }, "pr", "open", []),
        },
        {
          name: "LIGHT_REVIEW via complexity <= 1 and low human_decision",
          expectedSignal: "LIGHT_REVIEW",
          action: () =>
            deriveResolutionAction(
              {
                code_review_complexity: { type: "score", score: 1 },
                human_decision_required: { type: "noul", noul: 0.1 },
              },
              "pr",
              "open",
              [],
            ),
        },
        {
          name: "READY_FOR_MAINTAINER default",
          expectedSignal: "READY_FOR_MAINTAINER",
          action: () => deriveResolutionAction({}, "pr", "open", []),
        },
      ];

      for (const scenario of scenarios) {
        const result = scenario.action();
        expect(result.signal).toBe(scenario.expectedSignal);
        expect(result.requiresHumanApproval).toBe(true);
      }
    });
  });

  describe("Requirement 4: COMPLEX_REVIEW_NEEDED Does NOT Imply Automatic Execution", () => {
    it("ensures COMPLEX_REVIEW_NEEDED is an advisory signal and contains no automatic execution capabilities", () => {
      const result = deriveResolutionAction(
        {
          code_review_complexity: { type: "score", score: 3 },
        },
        "pr",
        "open",
        [],
      );

      expect(result.signal).toBe("COMPLEX_REVIEW_NEEDED");
      expect(result.requiresHumanApproval).toBe(true);

      // Verify that no automatic execution triggers or background worker dispatches exist on the result
      const untyped = result as unknown as Record<string, unknown>;
      expect(untyped.autoExecute).toBeUndefined();
      expect(untyped.executeLlm).toBeUndefined();
      expect(untyped.triggerReviewer).toBeUndefined();
      expect(untyped.dispatchWorkflow).toBeUndefined();

      // Only standard signal, reasons, and requiresHumanApproval properties exist
      expect(Object.keys(result).sort()).toEqual(["reasons", "requiresHumanApproval", "signal"]);
    });
  });

  describe("Requirement 5: False-Positive Security Keyword Test", () => {
    it("routes an item with 'security' only in body to LIGHT_REVIEW when complexity=1 and no safety gates trigger", () => {
      // Deterministic safety gates only inspect title and labels (per Stage A specification)
      const benignItem = createMockItem({
        title: "Clean up css styles and table alignment",
        labels: ["ui", "refactor"],
        body: "Follow up to security hardening discussion in team meeting; adjust column paddings.",
      });

      const safetyGates = evaluateDeterministicSafetyGates(benignItem);
      expect(safetyGates).toEqual([]); // No safety gates triggered from body alone

      const answers = {
        code_review_complexity: { type: "score", score: 1 },
        human_decision_required: { type: "noul", noul: 0.1 },
      };

      const result = deriveResolutionAction(answers, benignItem.type, benignItem.state, safetyGates);

      expect(result.signal).toBe("LIGHT_REVIEW");
      expect(result.signal).not.toBe("COMPLEX_REVIEW_NEEDED");
      expect(result.signal).not.toBe("MAINTAINER_DECISION");
      expect(result.requiresHumanApproval).toBe(true);
    });
  });

  describe("Requirement 6: Newer PR Is Not Automatically Valid Replacement", () => {
    it("ensures high superseded_candidate alone without already_resolved does NOT produce CLOSE_CANDIDATE", () => {
      const answers = {
        superseded_candidate: { type: "noul", noul: 0.9 },
      };

      const result = deriveResolutionAction(answers, "pr", "open", []);

      expect(result.signal).not.toBe("CLOSE_CANDIDATE");
      expect(result.signal).toBe("READY_FOR_MAINTAINER");
      expect(result.requiresHumanApproval).toBe(true);
    });

    it("does not produce CLOSE_CANDIDATE even if superseded is 0.99 and duplicate is 0.99, if already_resolved is absent", () => {
      const answers = {
        superseded_candidate: { type: "noul", noul: 0.99 },
        duplicate_candidate: { type: "noul", noul: 0.99 },
      };

      const result = deriveResolutionAction(answers, "pr", "open", []);

      // Needs both duplicate >= 0.8 AND already_resolved >= 0.7
      expect(result.signal).not.toBe("CLOSE_CANDIDATE");
      expect(result.signal).toBe("READY_FOR_MAINTAINER");
    });
  });

  describe("ResolutionDecisionRecord Structure", () => {
    it("allows constructing a complete valid ResolutionDecisionRecord with all fields", () => {
      const answers = {
        duplicate_candidate: { type: "noul", noul: 0.85, confidence: 0.92 },
        already_resolved_candidate: { type: "noul", noul: 0.78, confidence: 0.88 },
        code_review_complexity: { type: "score", score: 1, confidence: 0.95 },
      };

      const actionResult = deriveResolutionAction(answers, "pr", "open", []);

      const record: ResolutionDecisionRecord = {
        schemaVersion: RESOLUTION_QUESTIONS_SCHEMA_VERSION,
        rubricVersion: RESOLUTION_QUESTIONS_RUBRIC_VERSION,
        sourceItem: { repo: "owner/repo", number: 123, type: "pr" },
        targetItem: { repo: "owner/repo", number: 45, type: "issue" },
        answers,
        actionSignal: actionResult,
        provenance: createMockProvenance(),
        missingEvidence: ["link to merged pull request commit"],
        requiresManualVerification: true,
      };

      expect(record.schemaVersion).toBe("1.0.0");
      expect(record.rubricVersion).toBe("v1");
      expect(record.sourceItem.number).toBe(123);
      expect(record.targetItem?.number).toBe(45);
      expect(record.actionSignal.signal).toBe("CLOSE_CANDIDATE");
      expect(record.actionSignal.requiresHumanApproval).toBe(true);
      expect(record.requiresManualVerification).toBe(true);
      expect(record.provenance.provider).toBe("jev");
    });
  });
});
