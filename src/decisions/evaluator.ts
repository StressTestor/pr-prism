import type { PRItem } from "../types.js";
import { sanitizeItemForDecision } from "./sanitize.js";
import type {
  AdvisoryRoutingDecision,
  CategoryDecision,
  ChoiceAnswer,
  DecisionProvider,
  DecisionQuestions,
  ItemTypeDecision,
  NoulAnswer,
  RoutingThresholds,
  ScoreAnswer,
  TechnicalDomainDecision,
  TriageDecisionReport,
} from "./types.js";

export const TRIAGE_SCHEMA_VERSION = "1.0.0";

/**
 * Universal repository technical domain taxonomy.
 * Provides a generic default taxonomy applicable to arbitrary software repositories.
 */
export const GENERIC_TECHNICAL_DOMAINS: Record<string, string | null> = {
  core_logic: "Core application logic, business rules, features, data processing, or algorithms",
  api_service: "HTTP/RPC APIs, backend endpoints, network services, webhook listeners, or auth",
  ui_ux: "User interfaces, frontend web/desktop/mobile components, CLI interactions, or output display",
  data_storage: "Database schemas, persistence, storage engines, models, migrations, or caching",
  integrations: "Third-party services, external clients, SDK integrations, or hardware interfaces",
  ci_infra: "Build systems, CI/CD pipelines, containerization, deployment configs, or packaging",
  documentation: "Documentation, user guides, specifications, code comments, or tutorials",
  other: "Areas not matching the specific domains listed above",
};

/**
 * PR-Prism repository-specific technical domain taxonomy.
 * Retained for self-triage of the pr-prism codebase or custom configuration.
 */
export const PR_PRISM_TECHNICAL_DOMAINS: Record<string, string | null> = {
  core_engine: "Core triage pipeline, clustering, ranking, scoring, or algorithms",
  api_server: "Webhook server, Hono routes, GitHub event handling, or HTTP auth",
  cli_ux: "Command-line interface commands, terminal tables, flags, or output formatting",
  vector_storage: "SQLite, sqlite-vec, embeddings storage, migrations, or database schemas",
  git_integration: "GitHub API integration, GraphQL queries, REST clients, or Octokit",
  ci_build: "GitHub Actions workflows, build scripts, npm publishing, or dependencies",
  docs: "Documentation files, architecture specifications, or READMEs",
  other: "Areas not matching the specific domains listed",
};

/**
 * Standard triage decision questions catalog.
 * Bounded questions evaluating distinct semantic dimensions.
 *
 * Trusted GitHub metadata (such as item type pr vs issue) is resolved
 * deterministically from GitHub and is NOT queried via model inference.
 */
export const TRIAGE_QUESTIONS: DecisionQuestions = {
  category: {
    type: "choice",
    instructions: "What is the primary category of this contribution or report?",
    criteria: {
      bug: "Report or fix of unexpected failure, regression, crash, or incorrect behavior",
      feature_request: "New functionality, enhancement, or capability addition",
      documentation: "Documentation, typos, guides, README updates, comments, or examples",
      performance: "Speed, memory efficiency, resource consumption, or optimization",
      refactor: "Code restructuring without changing external observable behavior",
      dependency: "Package dependency updates, lockfile changes, or toolchain bumps",
      question: "User question, help request, configuration inquiry, or usage support",
      other: "Items that do not fit into the standard categories above",
    },
  },
  technical_domain: {
    type: "choice",
    instructions: "Which technical domain of the repository does this item primarily touch?",
    criteria: GENERIC_TECHNICAL_DOMAINS,
  },
  reproduction_evidence: {
    type: "score",
    instructions: "Rate the quality and availability of reproduction evidence in the report or PR.",
    criteria: [
      "Level 0: No reproduction steps, logs, error traces, or environment details provided",
      "Level 1: Partial details provided (e.g. error message or symptoms), but missing deterministic reproduction steps or environment",
      "Level 2: Clear, reproducible step-by-step instructions, minimal reproduction case, code snippet, or detailed test failure trace",
    ],
  },
  documentation_completeness: {
    type: "score",
    instructions: "Rate the completeness of the description, rationale, and context provided.",
    criteria: [
      "Level 0: Minimal, empty, or cryptic summary with little explanation of intent or context",
      "Level 1: Understandable description explaining what changed or happened, with basic rationale",
      "Level 2: Comprehensive documentation with clear context, motivation, edge cases, and before/after explanations",
    ],
  },
  technical_severity: {
    type: "score",
    instructions: "Rate the technical severity of the reported issue or defect.",
    criteria: [
      "Level 0: Cosmetic, typo, minor visual glitch, or negligible technical impact",
      "Level 1: Functional defect or degraded behavior, but a reasonable workaround exists",
      "Level 2: Critical defect, crash, security loophole, data loss, or blocking failure with no workaround",
    ],
  },
  has_security_risk: {
    type: "noul",
    instructions:
      "Does this item describe or introduce a potential security vulnerability, credential leak, authentication bypass, or unsafe execution?",
    criteria: {
      true: "Describes or touches security-sensitive areas, vulnerability reports, or credential exposures",
      false: "Standard non-security bug, feature, refactor, or documentation update",
    },
  },
  has_breaking_change: {
    type: "noul",
    instructions:
      "Does this item propose or report an incompatible change to existing public APIs, CLI flags, database formats, or breaking behavior?",
    criteria: {
      true: "Modifies existing public API contracts, CLI flags, or schema in a backwards-incompatible manner",
      false: "Additive, bugfix, or internal change that preserves backwards compatibility",
    },
  },
  investigation_needed: {
    type: "noul",
    instructions:
      "Does this item require deep technical investigation, code reproduction, or expert debugging before maintainer action?",
    criteria: {
      true: "Ambiguous root cause, hard-to-reproduce bug, or complex architecture interaction needing deep analysis",
      false: "Straightforward fix, clear bug with trivial resolution, or routine documentation change",
    },
  },
  candidate_routing: {
    type: "choice",
    instructions: "What is the recommended next triage path for this contribution or issue?",
    criteria: {
      maintainer_review: "Ready for routine maintainer review or standard triage",
      agent_investigate: "Needs deep technical investigation, automated reproduction, or LLM review",
      awaiting_repro: "Lacks sufficient evidence or reproduction steps; needs contributor clarification",
      security_escalation: "Requires immediate confidential security triage or senior maintainer escalation",
      documentation_only: "Documentation or minor fix suitable for quick review or community maintainers",
    },
  },
};

/**
 * Standard heuristic thresholds governing conservative advisory route selection
 * until empirical distribution calibration against repository data is available.
 */
export const DEFAULT_ROUTING_THRESHOLDS: RoutingThresholds = {
  securityRisk: 0.6,
  breakingChangeRisk: 0.6,
  investigationNeeded: 0.7,
  highTechnicalSeverity: 0.7,
  lowEvidenceQuality: 0.25,
  routineQualityScore: 0.8,
};

/**
 * Set of supported routing threshold keys.
 */
const VALID_ROUTING_THRESHOLD_KEYS = new Set<keyof RoutingThresholds>([
  "securityRisk",
  "breakingChangeRisk",
  "investigationNeeded",
  "highTechnicalSeverity",
  "lowEvidenceQuality",
  "routineQualityScore",
]);

/**
 * Validates that every configured routing threshold is a finite number within [0, 1].
 * Rejects NaN, Infinity, negative values, values > 1, and non-numeric runtime types.
 * Does not silently clamp invalid configurations.
 */
export function validateRoutingThresholds(
  customThresholds?: Partial<RoutingThresholds> | Record<string, unknown>,
): RoutingThresholds {
  if (customThresholds !== undefined && customThresholds !== null) {
    if (typeof customThresholds !== "object" || Array.isArray(customThresholds)) {
      throw new Error("Routing thresholds configuration must be an object");
    }

    for (const [key, val] of Object.entries(customThresholds)) {
      if (!VALID_ROUTING_THRESHOLD_KEYS.has(key as keyof RoutingThresholds)) {
        throw new Error(
          `Unknown routing threshold "${key}". Supported thresholds are: [${Array.from(VALID_ROUTING_THRESHOLD_KEYS).join(", ")}]`,
        );
      }
      if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val) || val < 0 || val > 1) {
        throw new Error(
          `Invalid routing threshold for "${key}": expected a finite number within [0, 1], received ${String(val)}`,
        );
      }
    }
  }

  const merged: RoutingThresholds = {
    ...DEFAULT_ROUTING_THRESHOLDS,
    ...customThresholds,
  };

  for (const key of VALID_ROUTING_THRESHOLD_KEYS) {
    const val = merged[key];
    if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val) || val < 0 || val > 1) {
      throw new Error(
        `Invalid routing threshold for "${key}": expected a finite number within [0, 1], received ${String(val)}`,
      );
    }
  }

  return merged;
}

export interface EvaluateItemOptions {
  model?: string;
  timeoutMs?: number;
  prQualityScore?: number;
  productRelevanceScore?: number;
  customQuestions?: DecisionQuestions;
  /** Configurable technical domain taxonomy criteria. Defaults to GENERIC_TECHNICAL_DOMAINS. */
  technicalDomainCriteria?: Record<string, string | null>;
  /** Configurable routing thresholds. Defaults to DEFAULT_ROUTING_THRESHOLDS. */
  routingThresholds?: Partial<RoutingThresholds>;
}

/**
 * Evaluates an untrusted PR/issue item against the decision questions
 * using the provided DecisionProvider.
 *
 * Produces a structured TriageDecisionReport maintaining strict separation
 * between:
 * - PR Quality (deterministic signals)
 * - Product Relevance (vision alignment)
 * - Evidence Quality & Completeness (reproduction & description score)
 * - Technical Severity & Risk (failure severity & risk nouls)
 *
 * Conservative Routing Precedence:
 * 1. Security risk: missing/malformed or >= threshold routes to security_escalation.
 * 2. High breaking-change risk: triggers technical or maintainer investigation.
 * 3. High technical severity: blocks routine review, doc-only, or needs-reproduction dismissal.
 * 4. Expert investigation: high investigation probability or agent routing recommendation.
 * 5. Mandatory assessment completeness: incomplete risk/severity fields default to maintainer triage.
 * 6. Low evidence quality: issues lacking reproduction steps route to needs_reproduction (only when all mandatory risk assessments are complete and confirmed low/moderate).
 * 7. Documentation-only: low risk, low severity documentation changes.
 * 8. Routine review: high quality deterministic PR score with low risk and low severity.
 * 9. Default fallback: maintainer triage.
 */
export async function evaluateItemDecisions(
  item: PRItem,
  provider: DecisionProvider,
  options: EvaluateItemOptions = {},
): Promise<TriageDecisionReport> {
  const sanitizedState = sanitizeItemForDecision(item);
  const thresholds: RoutingThresholds = validateRoutingThresholds(options.routingThresholds);

  // Construct questions catalog honoring configurable technical domain taxonomy
  let questions = options.customQuestions ?? TRIAGE_QUESTIONS;
  if (options.technicalDomainCriteria && !options.customQuestions) {
    questions = {
      ...TRIAGE_QUESTIONS,
      technical_domain: {
        type: "choice",
        instructions:
          TRIAGE_QUESTIONS.technical_domain?.instructions ||
          "Which technical domain of the repository does this item primarily touch?",
        criteria: options.technicalDomainCriteria,
      },
    };
  }

  const result = await provider.evaluate(
    {
      state: sanitizedState as unknown as Record<string, unknown>,
      questions,
      model: options.model,
      schemaVersion: TRIAGE_SCHEMA_VERSION,
    },
    {
      timeoutMs: options.timeoutMs,
    },
  );

  const rawAnswers = result.answers;

  // P1-1: TRUSTED METADATA
  // GitHub item.type is authoritative and cannot be overridden by model-generated answers.
  const itemType: ItemTypeDecision = item.type === "pr" ? "pr" : "issue";

  // Category classification using own-property check to reject prototype properties
  const categoryAns = rawAnswers.category as ChoiceAnswer | undefined;
  const catDef = questions.category;
  const validCatCriteria =
    catDef && catDef.type === "choice" ? catDef.criteria : (TRIAGE_QUESTIONS.category as any).criteria;
  const rawCategory = categoryAns?.choice;
  const category: CategoryDecision =
    rawCategory && Object.hasOwn(validCatCriteria, rawCategory) ? (rawCategory as CategoryDecision) : "other";

  // P2-4 & FINDING 3: Technical domain resolution using own-property check
  const domainAns = rawAnswers.technical_domain as ChoiceAnswer | undefined;
  const domainDef = questions.technical_domain;
  const validDomainCriteria = domainDef && domainDef.type === "choice" ? domainDef.criteria : GENERIC_TECHNICAL_DOMAINS;
  const rawDomainChoice = domainAns?.choice;
  const technicalDomain: TechnicalDomainDecision =
    rawDomainChoice && Object.hasOwn(validDomainCriteria, rawDomainChoice) ? rawDomainChoice : "other";

  // Helper to normalize score against defined rubric level bounds: levels 0..N-1 maps to 0..1
  const normalizeRubricScore = (ans: ScoreAnswer | undefined, questionKey: string): number | null => {
    if (!ans || typeof ans.score !== "number" || !Number.isFinite(ans.score)) return null;
    const qDef = questions[questionKey];
    const levels = qDef && qDef.type === "score" && Array.isArray(qDef.criteria) ? qDef.criteria.length : 3;
    const maxScore = Math.max(1, levels - 1);
    return Math.max(0, Math.min(1, ans.score / maxScore));
  };

  // Extract score dimensions (normalized to 0..1 scale based on defined rubric bounds)
  const reproAns = rawAnswers.reproduction_evidence as ScoreAnswer | undefined;
  const docAns = rawAnswers.documentation_completeness as ScoreAnswer | undefined;
  const severityAns = rawAnswers.technical_severity as ScoreAnswer | undefined;
  const securityAns = rawAnswers.has_security_risk as NoulAnswer | undefined;
  const breakingAns = rawAnswers.has_breaking_change as NoulAnswer | undefined;
  const investigationAns = rawAnswers.investigation_needed as NoulAnswer | undefined;
  const routingAns = rawAnswers.candidate_routing as ChoiceAnswer | undefined;

  const reproScoreNorm = normalizeRubricScore(reproAns, "reproduction_evidence") ?? 0.5;
  const docScoreNorm = normalizeRubricScore(docAns, "documentation_completeness") ?? 0.5;
  const severityNorm = normalizeRubricScore(severityAns, "technical_severity");

  const evidenceQuality = Math.round((reproScoreNorm * 0.7 + docScoreNorm * 0.3) * 100) / 100;

  // P1-2: MISSING RISK ASSESSMENTS
  // Represent unevaluated or missing assessments explicitly as null.
  // Never default absent risk assessments to probability zero.
  const securityRisk: number | null =
    securityAns && typeof securityAns.noul === "number" && Number.isFinite(securityAns.noul) ? securityAns.noul : null;

  const breakingChangeRisk: number | null =
    breakingAns && typeof breakingAns.noul === "number" && Number.isFinite(breakingAns.noul) ? breakingAns.noul : null;

  const investigationNeeded: number | null =
    investigationAns && typeof investigationAns.noul === "number" && Number.isFinite(investigationAns.noul)
      ? investigationAns.noul
      : null;

  // Conservative advisory route resolution — purely advisory, never closes
  const reasons: string[] = [];
  let advisoryRoute: AdvisoryRoutingDecision = "maintainer_triage";

  const hasValidSecurity = securityRisk !== null && securityRisk >= 0 && securityRisk <= 1;
  const hasValidBreaking = breakingChangeRisk !== null && breakingChangeRisk >= 0 && breakingChangeRisk <= 1;
  const hasValidInvestigation = investigationNeeded !== null && investigationNeeded >= 0 && investigationNeeded <= 1;
  const hasValidSeverity = severityNorm !== null && severityNorm >= 0 && severityNorm <= 1;

  if (!hasValidSecurity) {
    // 1a. Unknown or malformed security-critical assessment: safe escalation behavior
    advisoryRoute = "security_escalation";
    reasons.push("Security risk assessment is unevaluated, missing, or malformed; escalated for safety review");
  } else if (securityRisk >= thresholds.securityRisk) {
    // 1b. High security risk always receives security escalation
    advisoryRoute = "security_escalation";
    reasons.push(`Security risk flag raised with probability ${securityRisk.toFixed(2)}`);
  } else if (hasValidBreaking && breakingChangeRisk >= thresholds.breakingChangeRisk) {
    // 2. High breaking-change risk triggers technical investigation
    advisoryRoute = "expert_investigation";
    reasons.push(
      `High breaking-change risk probability ${breakingChangeRisk.toFixed(2)} triggers technical investigation`,
    );
  } else if (hasValidSeverity && severityNorm >= thresholds.highTechnicalSeverity) {
    // 3. High technical severity must not receive routine, documentation-only, or insufficient-evidence dismissal
    if (
      (hasValidInvestigation && investigationNeeded >= thresholds.investigationNeeded) ||
      routingAns?.choice === "agent_investigate"
    ) {
      advisoryRoute = "expert_investigation";
      const probStr = hasValidInvestigation ? `probability ${investigationNeeded.toFixed(2)}` : "agent recommendation";
      reasons.push(
        `Critical technical severity (${severityNorm.toFixed(2)}) and investigation ${probStr} indicate expert analysis needed`,
      );
    } else {
      advisoryRoute = "maintainer_triage";
      reasons.push(
        `High technical severity (${severityNorm.toFixed(2)}) requires maintainer triage; routine, documentation-only, or insufficient-evidence dismissal blocked`,
      );
    }
  } else if (
    (hasValidInvestigation && investigationNeeded >= thresholds.investigationNeeded) ||
    routingAns?.choice === "agent_investigate"
  ) {
    // 4. Investigation needed triggers expert investigation
    advisoryRoute = "expert_investigation";
    const probStr = hasValidInvestigation ? `probability ${investigationNeeded.toFixed(2)}` : "agent recommendation";
    reasons.push(`Investigation ${probStr} indicates non-trivial analysis needed`);
  } else if (!hasValidBreaking || !hasValidInvestigation || !hasValidSeverity) {
    // 5. Incomplete mandatory risk assessments: require complete mandatory assessment fields before needs_reproduction, routine or doc-only routing
    advisoryRoute = "maintainer_triage";
    const missing: string[] = [];
    if (!hasValidBreaking) missing.push("breaking change risk");
    if (!hasValidInvestigation) missing.push("investigation needed");
    if (!hasValidSeverity) missing.push("technical severity");
    reasons.push(
      `Mandatory risk assessment incomplete (missing ${missing.join(", ")}); defaulting to maintainer triage`,
    );
  } else if (evidenceQuality < thresholds.lowEvidenceQuality && itemType === "issue") {
    // 6. Insufficient evidence on issues (only reached when all mandatory risk assessments are complete and confirmed low/moderate)
    advisoryRoute = "needs_reproduction";
    reasons.push(`Low reproduction evidence (${evidenceQuality.toFixed(2)}) requires contributor clarification`);
  } else if (category === "documentation") {
    // 7. Safe documentation change (low risk and low severity verified)
    advisoryRoute = "documentation_only";
    reasons.push(
      "Categorized as documentation with low risk and low severity; suitable for direct maintainer or docs review",
    );
  } else if (
    itemType === "pr" &&
    options.prQualityScore !== undefined &&
    options.prQualityScore >= thresholds.routineQualityScore
  ) {
    // 8. Routine review for high quality PRs (low risk and low severity verified)
    advisoryRoute = "routine_review";
    reasons.push("High quality deterministic PR score with low risk and low severity; ready for standard review");
  } else {
    // 9. Standard maintainer triage fallback
    advisoryRoute = "maintainer_triage";
    reasons.push("Standard maintainer review path");
  }

  return {
    item: {
      repo: item.repo,
      number: item.number,
      type: itemType,
      title: item.title,
    },
    classification: {
      itemType,
      category,
      technicalDomain,
    },
    dimensions: {
      prQuality: options.prQualityScore,
      productRelevance: options.productRelevanceScore,
      evidenceQuality,
      technicalSeverity: severityNorm,
      securityRisk,
      breakingChangeRisk,
    },
    advisoryRoute,
    reasons,
    rawAnswers: rawAnswers as Record<string, any>,
    provenance: result.provenance,
  };
}
