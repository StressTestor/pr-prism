/**
 * Stage A — Jev-First Decomposed Typed Triage & Deterministic Safety Gates (Schema v2.0.0)
 *
 * Implements independent, fine-grained System One decisions using Choice, Score, and Noul
 * primitives over untrusted GitHub PR and Issue state, combined via explicit deterministic
 * application logic.
 *
 * Key Guarantees:
 * - Pinned model default: `jev-1.14.0` for reproducible evaluations.
 * - Independent questions for category, technical domain, operational priority, urgent blocker,
 *   security risk, privacy/PII risk, data-loss/corruption risk, breaking-change risk,
 *   production impact, complexity, reproduction evidence, missing information, goal relevance,
 *   and need for deep review.
 * - Deterministic safety safeguards (security, data-loss, breaking-change, critical priority labels)
 *   cannot be overridden or downgraded by Jev confidence or low model risk probabilities.
 * - Schema validity is never equated with factual correctness; missing/malformed risk answers
 *   fail closed to escalation.
 * - Full provenance preservation: model ID, per-option/per-level probabilities, confidence,
 *   uncertainty flags, input SHA-256 fingerprint, rubric hash, composite identity, token usage,
 *   latency, and estimated inference cost ($0.042 / 1M input tokens, output tokens free).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { PRItem } from "../types.js";
import { GENERIC_TECHNICAL_DOMAINS } from "./evaluator.js";
import { DEFAULT_JEV_MODEL } from "./jev-provider.js";
import { DEFAULT_MAX_TITLE, sanitizeUntrustedText } from "./sanitize.js";
import type {
  AdvisoryRoutingDecision,
  ChoiceAnswer,
  DecisionAnswer,
  DecisionProvenance,
  DecisionProvider,
  DecisionQuestions,
  ItemTypeDecision,
  NoulAnswer,
  ScoreAnswer,
  TechnicalDomainDecision,
} from "./types.js";

export const JEV_FIRST_SCHEMA_VERSION = "2.0.0";

/**
 * Official TypeSafe Jev 1.14 pricing (`https://docs.typesafe.ai/models`):
 * - Input tokens: $42 per 1B tokens = $0.042 per 1M tokens.
 * - Output tokens: $0.00 (free).
 */
export const JEV_INPUT_PRICE_PER_MTOK_USD = 0.042;

export function estimateJevInferenceCostUsd(inputTokens: number | null | undefined): number {
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0) {
    return 0;
  }
  return Number(((inputTokens / 1_000_000) * JEV_INPUT_PRICE_PER_MTOK_USD).toFixed(8));
}

/**
 * Computes a non-reversible 12-character SHA-256 hex fingerprint of a credential
 * for audit provenance without ever exposing or persisting the secret.
 */
export function computeCredentialFingerprint(secret: string): string {
  const cleaned = secret.trim().replace(/^["']|["']$/g, "");
  return createHash("sha256").update(cleaned).digest("hex").slice(0, 12);
}

export interface ResolveTypeSafeKeyOptions {
  explicitKey?: string;
  keyFilePath?: string;
  allowDefaultKeyFile?: boolean;
}

/**
 * Securely resolves the TypeSafe API key from explicit config, environment variable,
 * or optional key file (`~/.config/typesafe/jev-api-key`) without logging or leaking secrets.
 */
export function resolveTypeSafeApiKey(options: ResolveTypeSafeKeyOptions = {}): string | undefined {
  const rawExplicit = options.explicitKey || process.env.TYPESAFE_API_KEY;
  if (rawExplicit && rawExplicit.trim().length > 0) {
    return parseEnvOrRawKey(rawExplicit);
  }

  const candidates: string[] = [];
  if (options.keyFilePath) candidates.push(options.keyFilePath);
  if (process.env.TYPESAFE_API_KEY_FILE) candidates.push(process.env.TYPESAFE_API_KEY_FILE);
  if (options.allowDefaultKeyFile) {
    candidates.push(join(homedir(), ".config", "typesafe", "jev-api-key"));
    try {
      const realHome = userInfo().homedir;
      if (realHome && realHome !== homedir()) {
        candidates.push(join(realHome, ".config", "typesafe", "jev-api-key"));
      }
    } catch {
      // ignore userInfo errors in restricted environments
    }
  }

  for (const filePath of candidates) {
    if (filePath && existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8").trim();
        if (content.length > 0) {
          return parseEnvOrRawKey(content);
        }
      } catch {
        // try next candidate
      }
    }
  }

  return undefined;
}

function parseEnvOrRawKey(raw: string): string {
  const trimmed = raw.trim();
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const withoutExport = s.startsWith("export ") ? s.slice(7).trim() : s;
    if (withoutExport.includes("=")) {
      const [, val] = withoutExport.split("=", 2);
      return (val ?? "").trim().replace(/^["']|["']$/g, "");
    }
    return withoutExport.replace(/^["']|["']$/g, "");
  }
  return trimmed;
}

export type JevFirstCategory =
  | "security"
  | "bug"
  | "feature"
  | "documentation"
  | "tests"
  | "refactor"
  | "performance"
  | "dependencies"
  | "infrastructure"
  | "question"
  | "other";

export type JevPriorityTier = "critical" | "high" | "medium" | "low";
export type JevComplexityTier = "simple" | "moderate" | "complex";

export const JEV_FIRST_CATEGORIES: Record<JevFirstCategory, string> = {
  security:
    "Security vulnerability, authentication/authorization flaw, permission bypass, credential exposure, SSRF/XSS/RCE/injection, or security hardening",
  bug: "Unexpected runtime failure, regression, crash, data corruption, broken workflow, or bug fix",
  feature: "New capability, functional enhancement, new integration, or feature request",
  documentation: "Documentation, README, guides, architecture docs, comments, or typo fixes",
  tests: "Test suite additions, flaky test fixes, test fixture updates, or test harness improvements",
  refactor: "Internal code restructuring, cleanup, or modularization without changing external behavior",
  performance: "Speed, latency, memory usage, query efficiency, or resource optimization",
  dependencies: "Package dependency updates, library version bumps, or lockfile changes",
  infrastructure: "Build system, CI/CD workflow, Docker, packaging, or deployment configuration",
  question: "Usage question, support inquiry, troubleshooting help, or discussion",
  other: "Items that do not fit any specific category above",
};

/**
 * Decomposed 14-question Jev-First triage catalog (Schema v2.0.0).
 * Every question asks a single, coherent judgment using the matching System One primitive.
 */
export const JEV_FIRST_QUESTIONS: DecisionQuestions = {
  category: {
    type: "choice",
    instructions: "What is the primary category of this GitHub pull request or issue?",
    criteria: JEV_FIRST_CATEGORIES,
  },
  technical_domain: {
    type: "choice",
    instructions: "Which technical domain of the repository does this item primarily touch?",
    criteria: GENERIC_TECHNICAL_DOMAINS,
  },
  operational_priority: {
    type: "score",
    instructions: "Rate the operational priority and urgency of addressing this item.",
    criteria: [
      "Level 0 (Low): Cosmetic tweak, typo, minor documentation polish, or non-urgent cleanup",
      "Level 1 (Medium): Normal bug fix, standard feature work, refactor, or routine test improvement",
      "Level 2 (High): Major functional regression, security/privacy exposure, data-loss hazard, or broken core workflow",
      "Level 3 (Critical): Catastrophic outage, active exploit/zero-day, severe irreversible data loss, or release blocker",
    ],
  },
  is_urgent_blocker: {
    type: "noul",
    instructions:
      "Does this item report or fix an active release blocker, catastrophic crash, or urgent regression requiring immediate maintainer intervention?",
    criteria: {
      true: "Active blocker, crash in primary workflow, or urgent regression needing immediate action",
      false: "Standard backlog item, enhancement, or non-blocking issue/PR",
    },
  },
  security_vulnerability_risk: {
    type: "noul",
    instructions:
      "Does this item describe, introduce, or modify authentication, authorization, credentials/tokens, permissions, sandbox boundaries, or a security vulnerability (such as XSS, SSRF, RCE, injection, or privilege bypass)?",
    criteria: {
      true: "Touches security boundaries, auth/tokens/permissions, or reports/fixes a vulnerability",
      false:
        "Does not involve security vulnerabilities, authentication, permissions, or untrusted execution boundaries",
    },
  },
  privacy_or_pii_risk: {
    type: "noul",
    instructions:
      "Does this item involve privacy leaks, unauthorized exposure of personal/user data (PII), cross-tenant data leakage, or logging of sensitive user content?",
    criteria: {
      true: "Involves user privacy, PII handling, cross-user state isolation, or sensitive data exposure",
      false: "No privacy or personal data exposure implications",
    },
  },
  data_loss_or_corruption_risk: {
    type: "noul",
    instructions:
      "Does this item describe or risk irreversible data loss, database/storage corruption, destructive schema migration, or unintended deletion of user state or memory?",
    criteria: {
      true: "Describes or risks data loss, state corruption, destructive migration, or unintended deletion",
      false: "Preserves data integrity with no destructive state or storage risk",
    },
  },
  breaking_change_risk: {
    type: "noul",
    instructions:
      "Does this item propose or report a backwards-incompatible change to public APIs, CLI flags, configuration formats, persisted schemas, or existing user workflows?",
    criteria: {
      true: "Introduces or reports a breaking change to existing interfaces, configs, or schemas",
      false: "Backwards-compatible bug fix, additive feature, test, or internal change",
    },
  },
  production_impact: {
    type: "score",
    instructions: "Rate the potential impact of this item on production runtime behavior and system stability.",
    criteria: [
      "Level 0 (None): No production runtime impact (documentation, comments, test-only changes, or dev tooling)",
      "Level 1 (Moderate): Localized runtime behavior change, non-critical bug fix, or opt-in feature",
      "Level 2 (Severe): Affects core runtime execution path, crash/deadlock/race condition, security boundary, or data persistence",
    ],
  },
  change_complexity: {
    type: "score",
    instructions: "Rate the technical complexity of the change or reported problem.",
    criteria: [
      "Level 0 (Simple): Localized, self-contained change or straightforward single-component issue",
      "Level 1 (Moderate): Multi-file or subsystem change with clear component boundaries",
      "Level 2 (Complex): Cross-cutting architectural change, concurrency/distributed state, migration, or subtle multi-component interaction",
    ],
  },
  reproduction_evidence: {
    type: "score",
    instructions:
      "Rate the completeness of reproduction steps, diagnostic evidence, and verification details provided.",
    criteria: [
      "Level 0 (Missing): Minimal, empty, or vague description lacking reproduction steps, logs, or verification details",
      "Level 1 (Partial): Describes symptoms or intent, but lacks deterministic reproduction steps, environment details, or test verification",
      "Level 2 (Complete): Clear step-by-step reproduction, stack traces/logs, root-cause explanation, or concrete test verification",
    ],
  },
  missing_information: {
    type: "noul",
    instructions:
      "Is critical context, reproduction detail, or rationale missing from the description such that a maintainer cannot safely evaluate or verify this item from the text alone?",
    criteria: {
      true: "Missing essential reproduction steps, context, or verification evidence",
      false: "Description provides sufficient context and evidence for initial evaluation",
    },
  },
  goal_relevance: {
    type: "score",
    instructions:
      "Rate how relevant this item is to core project reliability, security, maintainability, and user workflows.",
    criteria: [
      "Level 0 (Low): Off-scope, spam, invalid report, or trivial cosmetic noise",
      "Level 1 (Moderate): Valid peripheral improvement, niche edge case, or routine maintenance",
      "Level 2 (High): Directly improves core product correctness, security, stability, or primary user workflows",
    ],
  },
  needs_deep_review: {
    type: "noul",
    instructions:
      "Does this item require deep senior maintainer or reasoning-LLM code/architecture review (due to security sensitivity, data-loss risk, breaking changes, complex architecture, or severe production impact) rather than routine local triage?",
    criteria: {
      true: "Warrants deep code/architecture review or senior maintainer investigation",
      false: "Suitable for routine local triage without deep reasoning-model escalation",
    },
  },
};

// ── Deterministic Safety Safeguards ──────────────────────────────

const SECURITY_GATE_REGEX =
  /\b(security|vulnerab\w*|exploit\w*|cve-\d{4}-\d+|credential\w*|secret\w*|token\w*|oauth\w*|authenticat\w*|authoriz\w*|privilege\w*|injection\w*|sandbox escape|rce|csrf|xss|ssrf|password\w*)\b/i;

const DATA_LOSS_GATE_REGEX =
  /\b(data[-_\s]+loss|data[-_\s]+leak|data[-_\s]+corruption|database drop|drop table|truncate table|destruct\w*|permanent loss|privacy violation|pii leak|memory consolidation)\b/i;

const BREAKING_GATE_REGEX =
  /\b(breaking[-_\s]+change|backward[-_\s]+compat\w*|breaking[-_\s]+migration|incompatible[-_\s]+api)\b/i;

const PRIORITY_LABEL_GATE_REGEX = /\b(critical|p0|p1|blocker|severity:\s*critical|priority:\s*high)\b/i;

/**
 * Evaluates independent deterministic safety gates from trusted GitHub title and labels.
 *
 * Hard invariant: Deterministic safety safeguards cannot be overridden or downgraded
 * by Jev confidence or low model-assigned risk probabilities.
 */
export function evaluateDeterministicSafetyGates(item: Pick<PRItem, "title" | "labels" | "body">): string[] {
  const gates: string[] = [];
  const labels = Array.isArray(item.labels) ? item.labels.map(String) : [];
  const labelsText = labels.join(" ");
  const headerText = `${item.title || ""} ${labelsText}`;

  const secMatch = headerText.match(SECURITY_GATE_REGEX);
  if (secMatch) {
    gates.push(`safety_gate:security(${secMatch[0].toLowerCase()})`);
  }

  const dataLossMatch = headerText.match(DATA_LOSS_GATE_REGEX);
  if (dataLossMatch) {
    gates.push(`safety_gate:data_loss(${dataLossMatch[0].toLowerCase()})`);
  }

  const breakingMatch = headerText.match(BREAKING_GATE_REGEX);
  if (breakingMatch) {
    gates.push(`safety_gate:breaking(${breakingMatch[0].toLowerCase()})`);
  }

  const prioMatch = labelsText.match(PRIORITY_LABEL_GATE_REGEX);
  if (prioMatch) {
    gates.push(`safety_gate:priority_label(${prioMatch[0].toLowerCase()})`);
  }

  return gates;
}

export interface JevFirstRoutingThresholds {
  securityRisk: number;
  privacyRisk: number;
  dataLossRisk: number;
  breakingChangeRisk: number;
  urgentBlockerRisk: number;
  deepReviewProb: number;
  highPriorityNorm: number;
  severeProductionImpactNorm: number;
  complexChangeNorm: number;
  borderlineSafetyRisk: number;
  lowEvidenceNorm: number;
  routinePrQuality: number;
}

export const DEFAULT_JEV_FIRST_THRESHOLDS: JevFirstRoutingThresholds = {
  securityRisk: 0.5,
  privacyRisk: 0.5,
  dataLossRisk: 0.5,
  breakingChangeRisk: 0.55,
  urgentBlockerRisk: 0.5,
  deepReviewProb: 0.55,
  highPriorityNorm: 0.58, // >= 1.74 on 0..3 rubric -> High or Critical
  severeProductionImpactNorm: 0.72, // >= 1.44 on 0..2 rubric -> Severe
  complexChangeNorm: 0.72, // >= 1.44 on 0..2 rubric -> Complex
  borderlineSafetyRisk: 0.3, // Borderline safety noul combined with production impact triggers caution escalation
  lowEvidenceNorm: 0.25,
  routinePrQuality: 0.8,
};

export interface JevDecomposedScores {
  operationalPriorityRaw: number | null;
  operationalPriorityNorm: number | null;
  operationalPriorityConfidence: number | null;
  urgentBlockerProb: number | null;
  securityVulnerabilityProb: number | null;
  privacyOrPiiProb: number | null;
  dataLossOrCorruptionProb: number | null;
  maxSafetyRiskProb: number | null;
  breakingChangeProb: number | null;
  productionImpactRaw: number | null;
  productionImpactNorm: number | null;
  productionImpactConfidence: number | null;
  changeComplexityRaw: number | null;
  changeComplexityNorm: number | null;
  changeComplexityConfidence: number | null;
  reproductionEvidenceRaw: number | null;
  reproductionEvidenceNorm: number | null;
  reproductionEvidenceConfidence: number | null;
  missingInformationProb: number | null;
  goalRelevanceRaw: number | null;
  goalRelevanceNorm: number | null;
  goalRelevanceConfidence: number | null;
  needsDeepReviewProb: number | null;
}

export interface JevFirstDecisionRecord {
  item: {
    repo: string;
    number: number;
    type: ItemTypeDecision;
    title: string;
    fullBodyLength: number;
    effectiveBodyLength: number;
    isInputTruncated: boolean;
  };
  classification: {
    itemType: ItemTypeDecision;
    category: JevFirstCategory;
    categoryConfidence: number | null;
    categoryProbabilities: Record<string, number>;
    technicalDomain: TechnicalDomainDecision;
    technicalDomainConfidence: number | null;
  };
  derived: {
    priorityTier: JevPriorityTier;
    complexityTier: JevComplexityTier;
    riskFlags: string[];
  };
  scores: JevDecomposedScores;
  routing: {
    advisory: true;
    escalateToDeepReview: boolean;
    advisoryRoute: AdvisoryRoutingDecision;
    escalationReasons: string[];
    deterministicSafetyGates: string[];
    uncertaintyFlags: string[];
  };
  rawAnswers: Record<string, DecisionAnswer>;
  provenance: DecisionProvenance & {
    estimatedCostUsd: number;
  };
}

export interface EvaluateJevFirstOptions {
  model?: string;
  timeoutMs?: number;
  maxBodyLength?: number;
  fullBodyLength?: number;
  prQualityScore?: number;
  productRelevanceScore?: number;
  thresholds?: Partial<JevFirstRoutingThresholds>;
}

/**
 * Prepares sanitized structured state for Jev-First v2 evaluation while tracking
 * exact full-description length and truncation status.
 */
export function prepareJevFirstState(
  item: PRItem,
  opts: { maxBodyLength?: number; fullBodyLength?: number } = {},
): {
  state: Record<string, unknown>;
  fullBodyLength: number;
  effectiveBodyLength: number;
  isInputTruncated: boolean;
} {
  const maxBody = opts.maxBodyLength ?? 14000;
  const rawBody = item.body || "";
  const fullBodyLength = opts.fullBodyLength ?? rawBody.length;
  const isInputTruncated = fullBodyLength > maxBody || rawBody.length > maxBody;
  const effectiveRawBody = rawBody.length > maxBody ? rawBody.slice(0, maxBody) : rawBody;
  const sanitizedBody = sanitizeUntrustedText(effectiveRawBody, maxBody, true);

  const state: Record<string, unknown> = {
    repo: sanitizeUntrustedText(item.repo, 200, false),
    number: Number.isInteger(item.number) ? item.number : 0,
    type: item.type === "pr" ? "pr" : "issue",
    title: sanitizeUntrustedText(item.title, DEFAULT_MAX_TITLE, true),
    labels: Array.isArray(item.labels)
      ? item.labels.map((l) => sanitizeUntrustedText(l, 100, false)).filter(Boolean)
      : [],
    description: sanitizedBody,
    description_length_chars: fullBodyLength,
    is_description_truncated: isInputTruncated,
  };

  if (item.type === "pr") {
    if (item.ciStatus) state.ci_status = item.ciStatus;
    if (item.hasTests !== undefined) state.has_tests = item.hasTests;
    if (item.additions !== undefined) state.additions = item.additions;
    if (item.deletions !== undefined) state.deletions = item.deletions;
    if (item.changedFiles !== undefined) state.changed_files = item.changedFiles;
  }

  return {
    state,
    fullBodyLength,
    effectiveBodyLength: effectiveRawBody.length,
    isInputTruncated,
  };
}

/**
 * Evaluates a GitHub PR or Issue with the 14-question decomposed Jev-First v2 schema
 * and combines the typed judgments with deterministic safety gates.
 */
export async function evaluateJevFirstItem(
  item: PRItem,
  provider: DecisionProvider,
  options: EvaluateJevFirstOptions = {},
): Promise<JevFirstDecisionRecord> {
  const maxBody = options.maxBodyLength ?? 14000;
  const { state, fullBodyLength, effectiveBodyLength, isInputTruncated } = prepareJevFirstState(item, {
    maxBodyLength: maxBody,
    fullBodyLength: options.fullBodyLength,
  });

  const thresholds: JevFirstRoutingThresholds = {
    ...DEFAULT_JEV_FIRST_THRESHOLDS,
    ...options.thresholds,
  };

  const result = await provider.evaluate(
    {
      state,
      questions: JEV_FIRST_QUESTIONS,
      model: options.model || DEFAULT_JEV_MODEL,
      schemaVersion: JEV_FIRST_SCHEMA_VERSION,
    },
    {
      timeoutMs: options.timeoutMs,
    },
  );

  return composeJevFirstDecisionRecord(item, result.answers, result.provenance, {
    fullBodyLength,
    effectiveBodyLength,
    isInputTruncated,
    thresholds,
    prQualityScore: options.prQualityScore,
  });
}

/**
 * Pure deterministic composition function that combines raw Jev answers, provenance,
 * and deterministic safety safeguards into a JevFirstDecisionRecord.
 * Separated from network I/O so composition rules can be tested and re-weighted offline.
 */
export function composeJevFirstDecisionRecord(
  item: PRItem,
  rawAnswers: Record<string, DecisionAnswer>,
  provenance: DecisionProvenance,
  context: {
    fullBodyLength?: number;
    effectiveBodyLength?: number;
    isInputTruncated?: boolean;
    thresholds?: Partial<JevFirstRoutingThresholds>;
    prQualityScore?: number;
  } = {},
): JevFirstDecisionRecord {
  const itemType: ItemTypeDecision = item.type === "pr" ? "pr" : "issue";
  const rawBody = item.body || "";
  const fullBodyLength = context.fullBodyLength ?? rawBody.length;
  const effectiveBodyLength = context.effectiveBodyLength ?? rawBody.length;
  const isInputTruncated = context.isInputTruncated ?? fullBodyLength > 14000;
  const thresholds: JevFirstRoutingThresholds = {
    ...DEFAULT_JEV_FIRST_THRESHOLDS,
    ...context.thresholds,
  };

  // 1. Category & Domain (Choice primitives)
  const catAns = rawAnswers.category as ChoiceAnswer | undefined;
  const rawCat = catAns?.choice;
  const category: JevFirstCategory =
    rawCat && Object.hasOwn(JEV_FIRST_CATEGORIES, rawCat) ? (rawCat as JevFirstCategory) : "other";
  const categoryConfidence =
    catAns && typeof catAns.confidence === "number" && Number.isFinite(catAns.confidence) ? catAns.confidence : null;
  const categoryProbabilities = catAns?.probabilities ?? {};

  const domAns = rawAnswers.technical_domain as ChoiceAnswer | undefined;
  const rawDom = domAns?.choice;
  const technicalDomain: TechnicalDomainDecision =
    rawDom && Object.hasOwn(GENERIC_TECHNICAL_DOMAINS, rawDom) ? rawDom : "other";
  const technicalDomainConfidence =
    domAns && typeof domAns.confidence === "number" && Number.isFinite(domAns.confidence) ? domAns.confidence : null;

  // Helper to extract Score primitive
  const extractScore = (
    key: string,
    maxLevel: number,
  ): { raw: number | null; norm: number | null; confidence: number | null } => {
    const ans = rawAnswers[key] as ScoreAnswer | undefined;
    if (!ans || typeof ans.score !== "number" || !Number.isFinite(ans.score)) {
      return { raw: null, norm: null, confidence: null };
    }
    const raw = ans.score;
    const norm = Math.max(0, Math.min(1, raw / Math.max(1, maxLevel)));
    const confidence = typeof ans.confidence === "number" && Number.isFinite(ans.confidence) ? ans.confidence : null;
    return { raw, norm, confidence };
  };

  // Helper to extract Noul primitive (strictly null when missing — never default to 0!)
  const extractNoul = (key: string): number | null => {
    const ans = rawAnswers[key] as NoulAnswer | undefined;
    if (!ans || typeof ans.noul !== "number" || !Number.isFinite(ans.noul) || ans.noul < 0 || ans.noul > 1) {
      return null;
    }
    return ans.noul;
  };

  const prio = extractScore("operational_priority", 3);
  const prodImpact = extractScore("production_impact", 2);
  const complexity = extractScore("change_complexity", 2);
  const reproEvidence = extractScore("reproduction_evidence", 2);
  const goalRel = extractScore("goal_relevance", 2);

  const urgentBlockerProb = extractNoul("is_urgent_blocker");
  const securityVulnerabilityProb = extractNoul("security_vulnerability_risk");
  const privacyOrPiiProb = extractNoul("privacy_or_pii_risk");
  const dataLossOrCorruptionProb = extractNoul("data_loss_or_corruption_risk");
  const breakingChangeProb = extractNoul("breaking_change_risk");
  const missingInformationProb = extractNoul("missing_information");
  const needsDeepReviewProb = extractNoul("needs_deep_review");

  const safetyComponents = [securityVulnerabilityProb, privacyOrPiiProb, dataLossOrCorruptionProb].filter(
    (v): v is number => v !== null,
  );
  const maxSafetyRiskProb = safetyComponents.length === 3 ? Math.max(...safetyComponents) : null;

  const scores: JevDecomposedScores = {
    operationalPriorityRaw: prio.raw,
    operationalPriorityNorm: prio.norm,
    operationalPriorityConfidence: prio.confidence,
    urgentBlockerProb,
    securityVulnerabilityProb,
    privacyOrPiiProb,
    dataLossOrCorruptionProb,
    maxSafetyRiskProb,
    breakingChangeProb,
    productionImpactRaw: prodImpact.raw,
    productionImpactNorm: prodImpact.norm,
    productionImpactConfidence: prodImpact.confidence,
    changeComplexityRaw: complexity.raw,
    changeComplexityNorm: complexity.norm,
    changeComplexityConfidence: complexity.confidence,
    reproductionEvidenceRaw: reproEvidence.raw,
    reproductionEvidenceNorm: reproEvidence.norm,
    reproductionEvidenceConfidence: reproEvidence.confidence,
    missingInformationProb,
    goalRelevanceRaw: goalRel.raw,
    goalRelevanceNorm: goalRel.norm,
    goalRelevanceConfidence: goalRel.confidence,
    needsDeepReviewProb,
  };

  // Derive comparable discrete tiers for priority, complexity, and risk flags
  let priorityTier: JevPriorityTier = "medium";
  if (
    (prio.raw !== null && prio.raw >= 2.5) ||
    (urgentBlockerProb !== null && urgentBlockerProb >= 0.85 && (prio.raw ?? 0) >= 2.0)
  ) {
    priorityTier = "critical";
  } else if (
    (prio.raw !== null && prio.raw >= 1.74) ||
    (urgentBlockerProb !== null && urgentBlockerProb >= thresholds.urgentBlockerRisk) ||
    (maxSafetyRiskProb !== null && maxSafetyRiskProb >= 0.7)
  ) {
    priorityTier = "high";
  } else if (prio.raw !== null && prio.raw < 0.65 && (maxSafetyRiskProb ?? 0) < 0.25) {
    priorityTier = "low";
  }

  let complexityTier: JevComplexityTier = "moderate";
  if (complexity.raw !== null) {
    if (complexity.raw >= 1.44) {
      complexityTier = "complex";
    } else if (complexity.raw < 0.65) {
      complexityTier = "simple";
    }
  }

  const riskFlags: string[] = [];
  if (securityVulnerabilityProb !== null && securityVulnerabilityProb >= thresholds.securityRisk) {
    riskFlags.push("security");
  }
  if (privacyOrPiiProb !== null && privacyOrPiiProb >= thresholds.privacyRisk) {
    riskFlags.push("privacy");
  }
  if (dataLossOrCorruptionProb !== null && dataLossOrCorruptionProb >= thresholds.dataLossRisk) {
    riskFlags.push("data_loss");
  }
  if (breakingChangeProb !== null && breakingChangeProb >= thresholds.breakingChangeRisk) {
    riskFlags.push("breaking_change");
  }
  if (prodImpact.norm !== null && prodImpact.norm >= thresholds.severeProductionImpactNorm) {
    riskFlags.push("production");
  }
  if (riskFlags.length === 0) {
    riskFlags.push("none");
  }

  // Uncertainty tracking (distribution concentration & evidence completeness)
  const uncertaintyFlags: string[] = [];
  if (categoryConfidence !== null && categoryConfidence < 0.6) {
    uncertaintyFlags.push(`low_category_confidence(${categoryConfidence.toFixed(2)})`);
  }
  if (prio.confidence !== null && prio.confidence < 0.55) {
    uncertaintyFlags.push(`dispersed_priority_score(${prio.confidence.toFixed(2)})`);
  }
  if (complexity.confidence !== null && complexity.confidence < 0.55) {
    uncertaintyFlags.push(`dispersed_complexity_score(${complexity.confidence.toFixed(2)})`);
  }
  for (const [noulName, noulVal] of [
    ["security_risk", securityVulnerabilityProb],
    ["privacy_risk", privacyOrPiiProb],
    ["data_loss_risk", dataLossOrCorruptionProb],
    ["breaking_change", breakingChangeProb],
    ["needs_deep_review", needsDeepReviewProb],
  ] as const) {
    if (noulVal !== null && noulVal >= 0.35 && noulVal <= 0.65) {
      uncertaintyFlags.push(`ambiguous_noul:${noulName}(${noulVal.toFixed(2)})`);
    }
  }
  if (isInputTruncated) {
    uncertaintyFlags.push(`truncated_input(${fullBodyLength}>${effectiveBodyLength})`);
  }
  if (!rawBody.trim()) {
    uncertaintyFlags.push("missing_description");
  }
  if (missingInformationProb !== null && missingInformationProb >= 0.65) {
    uncertaintyFlags.push(`missing_information(${missingInformationProb.toFixed(2)})`);
  }

  // Deterministic safety gates (cannot be overridden by model confidence!)
  const deterministicSafetyGates = evaluateDeterministicSafetyGates(item);

  // Escalation & Advisory Route Resolution
  const escalationReasons: string[] = [];

  // 1. Deterministic safety gates always trigger escalation first
  if (deterministicSafetyGates.length > 0) {
    escalationReasons.push(...deterministicSafetyGates);
  }

  // 2. Fail-closed check on mandatory safety/risk assessments
  const missingMandatory: string[] = [];
  if (securityVulnerabilityProb === null) missingMandatory.push("security_vulnerability_risk");
  if (privacyOrPiiProb === null) missingMandatory.push("privacy_or_pii_risk");
  if (dataLossOrCorruptionProb === null) missingMandatory.push("data_loss_or_corruption_risk");
  if (breakingChangeProb === null) missingMandatory.push("breaking_change_risk");
  if (prio.norm === null) missingMandatory.push("operational_priority");
  if (prodImpact.norm === null) missingMandatory.push("production_impact");

  if (missingMandatory.length > 0) {
    escalationReasons.push(`missing_mandatory_assessments(${missingMandatory.join(",")})`);
    uncertaintyFlags.push(`missing_assessments(${missingMandatory.join(",")})`);
  }

  // 3. Explicit Jev safety / risk probabilities
  if (securityVulnerabilityProb !== null && securityVulnerabilityProb >= thresholds.securityRisk) {
    escalationReasons.push(`jev_security_risk(${securityVulnerabilityProb.toFixed(2)})`);
  }
  if (privacyOrPiiProb !== null && privacyOrPiiProb >= thresholds.privacyRisk) {
    escalationReasons.push(`jev_privacy_risk(${privacyOrPiiProb.toFixed(2)})`);
  }
  if (dataLossOrCorruptionProb !== null && dataLossOrCorruptionProb >= thresholds.dataLossRisk) {
    escalationReasons.push(`jev_data_loss_risk(${dataLossOrCorruptionProb.toFixed(2)})`);
  }
  if (breakingChangeProb !== null && breakingChangeProb >= thresholds.breakingChangeRisk) {
    escalationReasons.push(`jev_breaking_change_risk(${breakingChangeProb.toFixed(2)})`);
  }

  // 4. Priority & Urgent Blocker
  if (priorityTier === "critical" || priorityTier === "high") {
    escalationReasons.push(`priority:${priorityTier}`);
  }
  if (urgentBlockerProb !== null && urgentBlockerProb >= thresholds.urgentBlockerRisk) {
    escalationReasons.push(`urgent_blocker(${urgentBlockerProb.toFixed(2)})`);
  }

  // 5. Severe Production Impact
  if (prodImpact.norm !== null && prodImpact.norm >= thresholds.severeProductionImpactNorm) {
    escalationReasons.push(`severe_production_impact(${prodImpact.norm.toFixed(2)})`);
  }

  // 6. Borderline safety caution: never exclude potentially serious items based solely on sub-threshold risk
  if (
    maxSafetyRiskProb !== null &&
    maxSafetyRiskProb >= thresholds.borderlineSafetyRisk &&
    maxSafetyRiskProb < thresholds.securityRisk &&
    (prodImpact.norm ?? 0) >= 0.5
  ) {
    escalationReasons.push(`borderline_safety_with_prod_impact(${maxSafetyRiskProb.toFixed(2)})`);
  }

  // 7. Need for deep review (guarded against routine doc/test false positives)
  const isRoutineTestOrDoc =
    (category === "documentation" || category === "tests") &&
    (priorityTier === "low" || priorityTier === "medium") &&
    deterministicSafetyGates.length === 0 &&
    (maxSafetyRiskProb ?? 0) < thresholds.borderlineSafetyRisk &&
    (breakingChangeProb ?? 0) < thresholds.breakingChangeRisk &&
    (prodImpact.norm ?? 0) < 0.5;

  if (needsDeepReviewProb !== null && needsDeepReviewProb >= thresholds.deepReviewProb) {
    if (isRoutineTestOrDoc) {
      uncertaintyFlags.push(`suppressed_routine_doc_test_escalation(${needsDeepReviewProb.toFixed(2)})`);
    } else {
      escalationReasons.push(`jev_needs_deep_review(${needsDeepReviewProb.toFixed(2)})`);
    }
  }

  // 8. Complex architectural changes
  if (complexityTier === "complex" && !isRoutineTestOrDoc) {
    if (itemType === "pr" || priorityTier !== "low" || (needsDeepReviewProb ?? 0) >= 0.35) {
      escalationReasons.push(`complex_change(${(complexity.norm ?? 0).toFixed(2)})`);
    }
  }

  // 9. Input truncation or missing description on non-routine items
  if (isInputTruncated && !isRoutineTestOrDoc) {
    escalationReasons.push("input_truncated_over_limit");
  }
  if (!rawBody.trim() && !isRoutineTestOrDoc) {
    escalationReasons.push("missing_description");
  }

  const uniqueEscalationReasons = Array.from(new Set(escalationReasons));
  const escalateToDeepReview = uniqueEscalationReasons.length > 0;

  // Determine specific AdvisoryRoutingDecision
  let advisoryRoute: AdvisoryRoutingDecision = "maintainer_triage";
  const hasSecFailureOrGate =
    deterministicSafetyGates.some(
      (g) => g.startsWith("safety_gate:security") || g.startsWith("safety_gate:data_loss"),
    ) ||
    securityVulnerabilityProb === null ||
    (securityVulnerabilityProb !== null && securityVulnerabilityProb >= thresholds.securityRisk) ||
    (privacyOrPiiProb !== null && privacyOrPiiProb >= thresholds.privacyRisk) ||
    (dataLossOrCorruptionProb !== null && dataLossOrCorruptionProb >= thresholds.dataLossRisk);

  if (hasSecFailureOrGate) {
    advisoryRoute = "security_escalation";
  } else if (escalateToDeepReview) {
    advisoryRoute = "expert_investigation";
  } else if (
    itemType === "issue" &&
    reproEvidence.norm !== null &&
    reproEvidence.norm < thresholds.lowEvidenceNorm &&
    category === "bug"
  ) {
    advisoryRoute = "needs_reproduction";
  } else if (category === "documentation") {
    advisoryRoute = "documentation_only";
  } else if (
    itemType === "pr" &&
    context.prQualityScore !== undefined &&
    context.prQualityScore >= thresholds.routinePrQuality
  ) {
    advisoryRoute = "routine_review";
  } else {
    advisoryRoute = "maintainer_triage";
  }

  const estimatedCostUsd = estimateJevInferenceCostUsd(provenance.usage?.inputTokens);

  return {
    item: {
      repo: item.repo,
      number: item.number,
      type: itemType,
      title: item.title,
      fullBodyLength,
      effectiveBodyLength,
      isInputTruncated,
    },
    classification: {
      itemType,
      category,
      categoryConfidence,
      categoryProbabilities,
      technicalDomain,
      technicalDomainConfidence,
    },
    derived: {
      priorityTier,
      complexityTier,
      riskFlags,
    },
    scores,
    routing: {
      advisory: true,
      escalateToDeepReview,
      advisoryRoute,
      escalationReasons: uniqueEscalationReasons,
      deterministicSafetyGates,
      uncertaintyFlags: Array.from(new Set(uncertaintyFlags)),
    },
    rawAnswers,
    provenance: {
      ...provenance,
      estimatedCostUsd,
    },
  };
}
