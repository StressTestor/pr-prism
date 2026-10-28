/**
 * Stage B — Jev Typed Resolution Questions for Housekeeping (Schema v1.0.0, Rubric v1)
 *
 * Implements typed, decomposed System One decision primitives (Noul, Score) for
 * housekeeping and resolution workflows:
 * - Duplicate and already-resolved candidate detection
 * - Superseded implementation candidate evaluation
 * - Missing information and actionability assessment
 * - Current project relevance and code review complexity scoring
 * - Human maintainer decision requirement detection
 *
 * All decision definitions are model-agnostic and evaluated through the Typed Decision Layer.
 * Action recommendations are computed via a pure deterministic policy with mandatory human approval.
 */

import type { DecisionProvenance, DecisionQuestions } from "../decisions/types.js";

export const RESOLUTION_QUESTIONS_SCHEMA_VERSION = "1.0.0";
export const RESOLUTION_QUESTIONS_RUBRIC_VERSION = "v1";

/**
 * 9 typed Jev question definitions for housekeeping resolution decisions.
 * Each question targets a single, well-defined judgment using Noul or Score primitives.
 */
export const RESOLUTION_QUESTIONS = {
  same_underlying_problem: {
    type: "noul",
    instructions:
      "Does the source item describe the same root cause or behavior as the target item, even if worded differently? Do not assume yes just because titles or keywords are similar.",
    criteria: {
      true: "Source and target items describe the same root cause, underlying failure mechanism, or core behavior",
      false: "Items describe distinct issues, different root causes, or superficially similar but unrelated behaviors",
    },
  },
  duplicate_candidate: {
    type: "noul",
    instructions:
      "Is this item likely redundant with another known item, given the evidence? Must consider that similar topics or overlapping keywords do not indicate the same problem.",
    criteria: {
      true: "Item is redundant with an existing open or resolved item addressing the same problem",
      false: "Item represents a distinct work item, separate issue, or independent approach",
    },
  },
  already_resolved_candidate: {
    type: "noul",
    instructions:
      "Is the problem described by this item likely already addressed by a merged fix? Requires citing the specific fix or commit evidence.",
    criteria: {
      true: "The reported problem or feature has already been addressed by an identified merged fix or commit",
      false: "The problem remains open and unresolved in the codebase, or lacks evidence of a merged fix",
    },
  },
  superseded_candidate: {
    type: "noul",
    instructions:
      "Has a newer, more complete implementation overtaken this item? A newer PR that omits part of an older solution is NOT a valid superseder.",
    criteria: {
      true: "A newer implementation completely encompasses, supersedes, and renders this item obsolete",
      false: "Item is not superseded, or any newer implementation is partial/incomplete compared to this item",
    },
  },
  missing_information: {
    type: "noul",
    instructions:
      "Does this item lack required information to reproduce or review (for bugs: steps, environment; for PRs: description, motivation)?",
    criteria: {
      true: "Lacks critical reproduction steps, environment details, or PR motivation/description required for evaluation",
      false: "Provides sufficient information, reproduction context, and rationale for maintainers to evaluate",
    },
  },
  actionable: {
    type: "noul",
    instructions: "Can a maintainer take a concrete next action on this item right now, given available information?",
    criteria: {
      true: "Maintainer can immediately review, reproduce, decide, or merge based on available information",
      false:
        "Blocked on external input, missing reproduction steps, or unresolved dependencies before action can be taken",
    },
  },
  current_project_relevance: {
    type: "score",
    instructions: "How relevant is this item to the project's current goals?",
    criteria: [
      "Level 0 (Irrelevant/Stale): Obsolete, unmaintained branch/version, spam, or off-scope for current roadmap",
      "Level 1 (Marginally Relevant): Peripheral suggestion, cosmetic polish, or low-priority edge case",
      "Level 2 (Relevant): Aligns with active maintenance, supported user workflows, or standard feature improvements",
      "Level 3 (Highly Relevant): Core project priority, critical functional enhancement, or active milestone deliverable",
    ],
  },
  code_review_complexity: {
    type: "score",
    instructions: "How complex is reviewing this PR or change? Note that complexity is not equal to criticality.",
    criteria: [
      "Level 0 (Trivial): Trivial documentation, typo fixes, comments, or isolated minimal test additions",
      "Level 1 (Routine): Standard single-component bug fix or routine feature with clear scope",
      "Level 2 (Intermediate): Moderate complexity requiring domain knowledge, multi-component interaction, or subtle logic",
      "Level 3 (Complex): High complexity involving cross-cutting architecture, security boundaries, concurrency, or schema migrations",
    ],
  },
  human_decision_required: {
    type: "noul",
    instructions:
      "Does this item require a human maintainer decision that cannot be automated (e.g., policy judgment, incomplete evidence, contested direction)?",
    criteria: {
      true: "Requires human maintainer judgment, policy discretion, architectural consensus, or evaluation of contested direction",
      false: "Standard deterministic triage, routine mechanical review, or well-defined automated workflow",
    },
  },
} satisfies DecisionQuestions;

export type ResolutionQuestionKey = keyof typeof RESOLUTION_QUESTIONS;

/**
 * Deterministic action signals recommended for housekeeping items.
 *
 * NOTE: COMPLEX_REVIEW_NEEDED indicates human or advanced AI review is warranted;
 * it does NOT imply or trigger automatic LLM/GLM execution.
 */
export type ResolutionActionSignal =
  | "CLOSE_CANDIDATE"
  | "REQUEST_INFORMATION"
  | "LIGHT_REVIEW"
  | "INTERMEDIATE_REVIEW"
  | "COMPLEX_REVIEW_NEEDED" // human or advanced AI review warranted — NOT automatic LLM execution
  | "MAINTAINER_DECISION"
  | "READY_FOR_MAINTAINER";

export interface ResolutionActionResult {
  signal: ResolutionActionSignal;
  reasons: string[]; // deterministic reasons that drove this signal
  requiresHumanApproval: boolean; // always true
}

export interface ResolutionDecisionRecord {
  schemaVersion: string;
  rubricVersion: string;
  sourceItem: { repo: string; number: number; type: "pr" | "issue" };
  targetItem?: { repo: string; number: number; type: "pr" | "issue" }; // for pairwise decisions
  answers: Partial<
    Record<keyof typeof RESOLUTION_QUESTIONS, { noul?: number; score?: number; type: string; confidence?: number }>
  >;
  actionSignal: ResolutionActionResult;
  provenance: DecisionProvenance;
  missingEvidence: string[]; // what evidence would improve confidence
  requiresManualVerification: boolean; // always true
}

/**
 * Pure deterministic function to derive resolution action signal from Jev answers,
 * item metadata, and deterministic safety gates.
 *
 * Invariants:
 * 1. If any safety gate triggered → MAINTAINER_DECISION (safety gates are non-overridable)
 * 2. If duplicate_candidate.noul >= 0.8 AND already_resolved_candidate.noul >= 0.7 → CLOSE_CANDIDATE
 * 3. If missing_information.noul >= 0.75 AND actionable.noul < 0.4 → REQUEST_INFORMATION
 * 4. If code_review_complexity.score == 3 → COMPLEX_REVIEW_NEEDED
 * 5. If code_review_complexity.score == 2 → INTERMEDIATE_REVIEW
 * 6. If code_review_complexity.score <= 1 AND human_decision_required.noul < 0.5 → LIGHT_REVIEW
 * 7. If human_decision_required.noul >= 0.7 → MAINTAINER_DECISION
 * 8. Default → READY_FOR_MAINTAINER
 *
 * requiresHumanApproval is ALWAYS true.
 */
export function deriveResolutionAction(
  answers: Partial<Record<keyof typeof RESOLUTION_QUESTIONS, { noul?: number; score?: number; type: string }>>,
  itemType: "pr" | "issue",
  itemState: string,
  safetyGates: string[],
): ResolutionActionResult {
  // Context parameters preserved for traceability and audit integrity
  void itemType;
  void itemState;

  const reasons: string[] = [];

  // Policy Rule 1: If any safety gate triggered → MAINTAINER_DECISION (safety gates are non-overridable)
  if (Array.isArray(safetyGates) && safetyGates.length > 0) {
    reasons.push(`Safety gate triggered: ${safetyGates.join(", ")}`);
    return {
      signal: "MAINTAINER_DECISION",
      reasons,
      requiresHumanApproval: true,
    };
  }

  // Policy Rule 2: If duplicate_candidate.noul >= 0.8 AND already_resolved_candidate.noul >= 0.7 → CLOSE_CANDIDATE
  const duplicateNoul = answers.duplicate_candidate?.noul;
  const resolvedNoul = answers.already_resolved_candidate?.noul;
  if (
    typeof duplicateNoul === "number" &&
    duplicateNoul >= 0.8 &&
    typeof resolvedNoul === "number" &&
    resolvedNoul >= 0.7
  ) {
    reasons.push(
      `Duplicate candidate (probability ${duplicateNoul} >= 0.8) and already resolved candidate (probability ${resolvedNoul} >= 0.7)`,
    );
    return {
      signal: "CLOSE_CANDIDATE",
      reasons,
      requiresHumanApproval: true,
    };
  }

  // Policy Rule 3: If missing_information.noul >= 0.75 AND actionable.noul < 0.4 → REQUEST_INFORMATION
  const missingInfoNoul = answers.missing_information?.noul;
  const actionableNoul = answers.actionable?.noul;
  if (
    typeof missingInfoNoul === "number" &&
    missingInfoNoul >= 0.75 &&
    typeof actionableNoul === "number" &&
    actionableNoul < 0.4
  ) {
    reasons.push(
      `Missing information (probability ${missingInfoNoul} >= 0.75) and not actionable (probability ${actionableNoul} < 0.4)`,
    );
    return {
      signal: "REQUEST_INFORMATION",
      reasons,
      requiresHumanApproval: true,
    };
  }

  // Policy Rule 4: If code_review_complexity.score == 3 → COMPLEX_REVIEW_NEEDED
  const complexityScore = answers.code_review_complexity?.score;
  const roundedComplexity = typeof complexityScore === "number" ? Math.round(complexityScore) : undefined;
  if (roundedComplexity === 3) {
    reasons.push(`Code review complexity score is ${complexityScore} (score 3: complex review needed)`);
    return {
      signal: "COMPLEX_REVIEW_NEEDED",
      reasons,
      requiresHumanApproval: true,
    };
  }

  // Policy Rule 5: If code_review_complexity.score == 2 → INTERMEDIATE_REVIEW
  if (roundedComplexity === 2) {
    reasons.push(`Code review complexity score is ${complexityScore} (score 2: intermediate review)`);
    return {
      signal: "INTERMEDIATE_REVIEW",
      reasons,
      requiresHumanApproval: true,
    };
  }

  // Policy Rule 6: If code_review_complexity.score <= 1 AND human_decision_required.noul < 0.5 → LIGHT_REVIEW
  const humanDecisionNoul = answers.human_decision_required?.noul;
  if (
    typeof complexityScore === "number" &&
    (complexityScore <= 1 || (roundedComplexity !== undefined && roundedComplexity <= 1)) &&
    (humanDecisionNoul === undefined || humanDecisionNoul < 0.5)
  ) {
    reasons.push(
      `Code review complexity score is ${complexityScore} (<= 1) and human decision not required (probability ${humanDecisionNoul ?? "unspecified"} < 0.5)`,
    );
    return {
      signal: "LIGHT_REVIEW",
      reasons,
      requiresHumanApproval: true,
    };
  }

  // Policy Rule 7: If human_decision_required.noul >= 0.7 → MAINTAINER_DECISION
  if (typeof humanDecisionNoul === "number" && humanDecisionNoul >= 0.7) {
    reasons.push(`Human decision required (probability ${humanDecisionNoul} >= 0.7)`);
    return {
      signal: "MAINTAINER_DECISION",
      reasons,
      requiresHumanApproval: true,
    };
  }

  // Policy Rule 8: Default → READY_FOR_MAINTAINER
  reasons.push("No explicit automated resolution rule triggered; ready for maintainer triage");
  return {
    signal: "READY_FOR_MAINTAINER",
    reasons,
    requiresHumanApproval: true,
  };
}
