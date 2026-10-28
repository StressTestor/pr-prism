/**
 * Typed Decision Layer — Core interfaces and types.
 *
 * Provides a model-agnostic abstraction over System One decision primitives:
 * - Choice: bounded categorical selection with probabilities and confidence
 * - Score: ordered rubric rating (0..N) with fractional score and confidence
 * - Noul: calibrated probability (0..1) of a proposition being true
 */

export interface ChoiceQuestionDef {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestionDef {
  type: "score";
  instructions: string;
  /** Ordered levels (from 0 upward). Must contain at least two entries. */
  criteria: string[];
}

export interface NoulQuestionDef {
  type: "noul";
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  } | null;
}

export type DecisionQuestionDef = ChoiceQuestionDef | ScoreQuestionDef | NoulQuestionDef;

export type DecisionQuestions = Record<string, DecisionQuestionDef>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerFor<Q extends DecisionQuestionDef> = Q extends ChoiceQuestionDef
  ? ChoiceAnswer
  : Q extends ScoreQuestionDef
    ? ScoreAnswer
    : Q extends NoulQuestionDef
      ? NoulAnswer
      : DecisionAnswer;

export interface DecisionProvenance {
  /** Provider identifier, e.g. "jev", "mock", or "disabled". */
  provider: string;
  /** Actual model version that answered, e.g. "jev-1.14.0". */
  model: string;
  /** Cryptographic SHA-256 hash of the sanitized input state. */
  inputHash: string;
  /** Version of the decision schema/catalog used. */
  decisionSchemaVersion: string;
  /** Cryptographic SHA-256 hash of question definitions, instructions, criteria, and schema version. */
  rubricHash: string;
  /** Composite decision identity hash combining inputHash, rubricHash, model, and schemaVersion. */
  decisionIdentity: string;
  /** Token usage statistics if reported by provider. */
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
  /** Wall-clock latency in milliseconds. */
  latencyMs?: number;
  /** ISO timestamp when the evaluation took place. */
  evaluatedAt: string;
}

export interface DecisionRequest<Q extends DecisionQuestions = DecisionQuestions> {
  /** The state/content to evaluate (sanitized structured object or text). */
  state: Record<string, unknown> | string;
  /** Named questions to evaluate against the state. */
  questions: Q;
  /** Model override; falls back to provider default. */
  model?: string;
  /** Schema version identifier for provenance tracking. Defaults to "1.0.0". */
  schemaVersion?: string;
}

export interface DecisionResult<Q extends DecisionQuestions = DecisionQuestions> {
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  provenance: DecisionProvenance;
}

export interface DecisionRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DecisionProvider {
  readonly id: string;
  readonly defaultModel: string;
  evaluate<Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
    options?: DecisionRequestOptions,
  ): Promise<DecisionResult<Q>>;
}

export interface DecisionConfig {
  enabled?: boolean;
  provider?: "jev" | "mock";
  model?: string;
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
}

// ── Standard Triage Types ────────────────────────────────────────

export type ItemTypeDecision = "pr" | "issue";

export type CategoryDecision =
  | "bug"
  | "feature_request"
  | "documentation"
  | "performance"
  | "refactor"
  | "dependency"
  | "question"
  | "other";

/**
 * Universal repository technical domain taxonomy.
 * Provides a generic default applicable to arbitrary software repositories.
 */
export type GenericTechnicalDomain =
  | "core_logic"
  | "api_service"
  | "ui_ux"
  | "data_storage"
  | "integrations"
  | "ci_infra"
  | "documentation"
  | "other";

/**
 * Technical domain classification. Allows generic domains as well as
 * configurable domain identifiers defined per repository.
 */
export type TechnicalDomainDecision = GenericTechnicalDomain | (string & {});

export type AdvisoryRoutingDecision =
  | "maintainer_triage"
  | "needs_reproduction"
  | "expert_investigation"
  | "security_escalation"
  | "documentation_only"
  | "routine_review";

export interface RoutingThresholds {
  /** Conservative heuristic threshold [0, 1] triggering security escalation. Defaults to 0.6. */
  securityRisk: number;
  /** Conservative heuristic threshold [0, 1] triggering breaking change investigation. Defaults to 0.6. */
  breakingChangeRisk: number;
  /** Conservative heuristic threshold [0, 1] triggering deep technical investigation. Defaults to 0.7. */
  investigationNeeded: number;
  /** Conservative heuristic normalized score threshold [0, 1] identifying critical technical severity. Defaults to 0.7. */
  highTechnicalSeverity: number;
  /** Conservative heuristic threshold [0, 1] below which an issue is flagged as lacking reproduction evidence. Defaults to 0.25. */
  lowEvidenceQuality: number;
  /** Conservative heuristic deterministic PR quality score threshold [0, 1] enabling routine review. Defaults to 0.8. */
  routineQualityScore: number;
}

export interface TriageDecisionReport {
  item: {
    repo: string;
    number: number;
    type: "pr" | "issue";
    title: string;
  };
  classification: {
    itemType: ItemTypeDecision;
    category: CategoryDecision;
    technicalDomain: TechnicalDomainDecision;
  };
  /**
   * Orthogonal dimensions kept strictly separated:
   * 1. PR Quality (deterministic signals from scorer.ts)
   * 2. Product Relevance (vision alignment)
   * 3. Evidence Quality (reproduction & description completeness)
   * 4. Technical Severity & Risk (failure impact and risk flags)
   */
  dimensions: {
    prQuality?: number;
    productRelevance?: number;
    evidenceQuality: number;
    technicalSeverity: number | null;
    securityRisk: number | null;
    breakingChangeRisk: number | null;
  };
  advisoryRoute: AdvisoryRoutingDecision;
  reasons: string[];
  rawAnswers: Record<string, DecisionAnswer>;
  provenance: DecisionProvenance;
}
