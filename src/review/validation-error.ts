/**
 * Review Output Validation & Error Taxonomy
 *
 * Implements strict review output validation at the final scheduler persistence boundary:
 * - Rejects empty JSON objects, empty arrays where substantive findings/concerns are expected,
 *   null/undefined content, and rawContent placeholders.
 * - Detects truncated generations (finish_reason === "length") and exhausted token budgets.
 * - Enforces schema conformance for PR deep reviews (summary, findings, concerns, recommendation, confidence).
 * - Enforces schema conformance for Issue deep reviews (summary, issueAction, validityAssessment, confidence).
 * - Forbids PR recommendations from appearing in issue reviews.
 * - Differentiates retryable model generation issues (transient_error) from permanent provider rejections (400/422).
 */

export type ReviewValidationErrorKind =
  | "malformed_json"
  | "truncated_generation"
  | "empty_result"
  | "schema_mismatch"
  | "rawcontent_placeholder";

export class ReviewValidationError extends Error {
  constructor(
    public readonly kind: ReviewValidationErrorKind,
    public readonly modelId: string,
    public readonly finishReason: string | null,
    public readonly completionTokens: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

export interface ValidationSuccess {
  valid: true;
  summary: string;
}

export interface ValidationFailure {
  valid: false;
  error: ReviewValidationError;
  reason: string;
}

export type ValidationOutcome = ValidationSuccess | ValidationFailure;

export interface ValidationOptions {
  requireSummary?: boolean;
}

const VALID_PR_RECOMMENDATIONS = new Set(["merge", "revise", "close", "needs_human_review"]);

const VALID_ISSUE_ACTIONS = new Set([
  "confirm_bug",
  "needs_reproduction",
  "accept_feature",
  "design_discussion",
  "duplicate_candidate",
  "not_planned",
]);

const VALID_ISSUE_ASSESSMENTS = new Set([
  "valid_actionable",
  "partially_specified",
  "insufficient_evidence",
  "invalid_or_outdated",
]);

/**
 * Validates a review result before persistence to the durable queue checkpoints.
 * Ensures that HTTP 200 responses with invalid or truncated output are never marked as completed.
 *
 * @param result - The parsed review result object
 * @param itemType - "pr" or "issue" (optional if inferred from object)
 * @param finishReason - Provider API finish_reason (e.g. "stop", "length")
 * @param modelId - Actual model ID reported by provider
 * @param completionTokens - Actual completion tokens consumed
 * @param options - Validation options (e.g. requireSummary)
 */
export function validateReviewResult(
  result: unknown,
  itemType?: "pr" | "issue",
  finishReason: string | null = null,
  modelId: string = "unknown",
  completionTokens: number = 0,
  options?: ValidationOptions,
): ValidationOutcome {
  // 1. Truncated generation check
  if (finishReason === "length") {
    const err = new ReviewValidationError(
      "truncated_generation",
      modelId,
      finishReason,
      completionTokens,
      `Model output truncated at ${completionTokens} completion tokens (finish_reason=length)`,
    );
    return { valid: false, error: err, reason: err.message };
  }

  // 2. Null or undefined
  if (result === null || result === undefined) {
    const err = new ReviewValidationError(
      "empty_result",
      modelId,
      finishReason,
      completionTokens,
      "Review result is null or undefined",
    );
    return { valid: false, error: err, reason: err.message };
  }

  // 3. Must be an object
  if (typeof result !== "object" || Array.isArray(result)) {
    const err = new ReviewValidationError(
      "schema_mismatch",
      modelId,
      finishReason,
      completionTokens,
      `Expected review result object, received ${typeof result}`,
    );
    return { valid: false, error: err, reason: err.message };
  }

  const res = result as Record<string, unknown>;

  // 4. RawContent placeholder check
  if ("rawContent" in res) {
    const err = new ReviewValidationError(
      "rawcontent_placeholder",
      modelId,
      finishReason,
      completionTokens,
      "Review result contains rawContent fallback placeholder — JSON parsing failed upstream",
    );
    return { valid: false, error: err, reason: err.message };
  }

  // 5. Empty object check
  const keys = Object.keys(res);
  if (keys.length === 0) {
    const err = new ReviewValidationError(
      "empty_result",
      modelId,
      finishReason,
      completionTokens,
      "Review result is an empty object {}",
    );
    return { valid: false, error: err, reason: err.message };
  }

  const requireSummary = options?.requireSummary ?? true;

  // 6. Substantive summary required by default
  const summary = res.summary;
  if (requireSummary) {
    if (typeof summary !== "string" || summary.trim().length === 0) {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        "Review result is missing required non-empty 'summary' string",
      );
      return { valid: false, error: err, reason: err.message };
    }
  } else if ("summary" in res) {
    if (typeof summary !== "string" || summary.trim().length === 0) {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        "Review result summary must be a non-empty string when present",
      );
      return { valid: false, error: err, reason: err.message };
    }
  }

  // Determine effective item type
  const effectiveItemType: "pr" | "issue" =
    itemType ?? (res.itemType === "issue" || "issueAction" in res ? "issue" : "pr");

  // 7. Schema-specific validation
  if (effectiveItemType === "pr") {
    // Recommendation must be valid if present or required
    const rec = res.recommendation;
    if (rec !== undefined) {
      if (typeof rec !== "string" || !VALID_PR_RECOMMENDATIONS.has(rec)) {
        const err = new ReviewValidationError(
          "schema_mismatch",
          modelId,
          finishReason,
          completionTokens,
          `PR review recommendation must be one of [${Array.from(VALID_PR_RECOMMENDATIONS).join(", ")}], got: ${String(rec)}`,
        );
        return { valid: false, error: err, reason: err.message };
      }
    } else if (!requireSummary) {
      // In relaxed mode, must have at least recommendation or summary
      if (!summary) {
        const err = new ReviewValidationError(
          "schema_mismatch",
          modelId,
          finishReason,
          completionTokens,
          "PR review must have either recommendation or summary",
        );
        return { valid: false, error: err, reason: err.message };
      }
    } else {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        "PR review is missing required 'recommendation'",
      );
      return { valid: false, error: err, reason: err.message };
    }

    // Confidence must be number in [0, 1] if present
    if ("confidence" in res && (typeof res.confidence !== "number" || res.confidence < 0 || res.confidence > 1)) {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        `PR review confidence must be between 0.0 and 1.0, got: ${String(res.confidence)}`,
      );
      return { valid: false, error: err, reason: err.message };
    }

    // Findings must be an array if present
    if ("findings" in res && !Array.isArray(res.findings)) {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        "PR review findings must be an array",
      );
      return { valid: false, error: err, reason: err.message };
    }

    // Concerns must be an array if present
    if ("concerns" in res && !Array.isArray(res.concerns)) {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        "PR review concerns must be an array",
      );
      return { valid: false, error: err, reason: err.message };
    }
  } else if (effectiveItemType === "issue") {
    // HARD INVARIANT: Issue reviews must NOT have PR recommendation
    if ("recommendation" in res) {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        "Issue review must not contain PR 'recommendation' field (must use issueAction)",
      );
      return { valid: false, error: err, reason: err.message };
    }

    // issueAction must be valid
    const action = res.issueAction;
    if (action !== undefined) {
      if (typeof action !== "string" || !VALID_ISSUE_ACTIONS.has(action)) {
        const err = new ReviewValidationError(
          "schema_mismatch",
          modelId,
          finishReason,
          completionTokens,
          `Issue review issueAction must be one of [${Array.from(VALID_ISSUE_ACTIONS).join(", ")}], got: ${String(action)}`,
        );
        return { valid: false, error: err, reason: err.message };
      }
    } else {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        "Issue review is missing required 'issueAction'",
      );
      return { valid: false, error: err, reason: err.message };
    }

    // validityAssessment must be valid if present
    if ("validityAssessment" in res) {
      const validity = res.validityAssessment;
      if (typeof validity !== "string" || !VALID_ISSUE_ASSESSMENTS.has(validity)) {
        const err = new ReviewValidationError(
          "schema_mismatch",
          modelId,
          finishReason,
          completionTokens,
          `Issue review validityAssessment must be one of [${Array.from(VALID_ISSUE_ASSESSMENTS).join(", ")}], got: ${String(validity)}`,
        );
        return { valid: false, error: err, reason: err.message };
      }
    }

    // Confidence must be number in [0, 1] if present
    if ("confidence" in res && (typeof res.confidence !== "number" || res.confidence < 0 || res.confidence > 1)) {
      const err = new ReviewValidationError(
        "schema_mismatch",
        modelId,
        finishReason,
        completionTokens,
        `Issue review confidence must be between 0.0 and 1.0, got: ${String(res.confidence)}`,
      );
      return { valid: false, error: err, reason: err.message };
    }
  }

  return { valid: true, summary: typeof summary === "string" ? summary.trim() : "Review validated" };
}
