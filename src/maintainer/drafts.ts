/**
 * Deterministic Draft Comment Generator (Task D - AGY-03)
 *
 * Generates structured, markdown-safe maintainer draft responses without LLM calls.
 * All drafts are advisory templates containing explicit disclaimers and human edit placeholders.
 *
 * Guarantees:
 * - Pure deterministic templates: no hallucinations, zero invented numbers/hashes/paths.
 * - Sanitized titles to avoid control character injection or table breakout.
 * - Explicit draft disclaimer on every comment.
 * - Clear identification of human-editable fields using `<!-- EDIT: [field description] -->`.
 */

import { sanitizeTitle } from "../sanitize.js";

export const DRAFT_DISCLAIMER = "<!-- DRAFT: Review and edit before submitting to GitHub. -->\n";

export type DraftCommentType =
  | "duplicate_closure"
  | "superseded_closure"
  | "request_info"
  | "request_tests"
  | "change_request"
  | "review_summary"
  | "issue_resolution"
  | "decline_out_of_scope";

export interface DraftComment {
  type: DraftCommentType;
  itemNumber: number;
  repo: string;
  subject: string; // PR/issue title (sanitized)
  body: string; // The draft markdown text
  editableFields: string[]; // list of placeholder fields the human must fill
  disclaimer: string; // Always present: "Draft — review before submitting"
}

/** Extracts all `<!-- EDIT: ... -->` placeholder field descriptions from a template body */
export function extractEditableFields(body: string): string[] {
  const matches = body.matchAll(/<!-- EDIT: (.*?) -->/g);
  const fields: string[] = [];
  for (const m of matches) {
    const field = m[1].trim();
    if (!fields.includes(field)) {
      fields.push(field);
    }
  }
  return fields;
}

/**
 * Generate a closure comment for a duplicate PR or issue.
 * Clearly differentiates confirmed identity duplicates from fuzzy embedding candidates.
 */
export function generateDuplicateClosureComment(opts: {
  repo: string;
  number: number;
  title: string;
  canonicalNumber: number;
  isConfirmed: boolean; // identity vs. fuzzy
  confidence?: string;
}): DraftComment {
  const subject = sanitizeTitle(opts.title || "");
  const duplicateNotice = opts.isConfirmed
    ? "This is a confirmed duplicate (identical commit/patch)."
    : "I've identified this as a likely duplicate based on semantic similarity. Please review both to confirm before closing.";

  const confidenceNotice = !opts.isConfirmed && opts.confidence ? `\nSimilarity confidence: ${opts.confidence}.\n` : "";

  const body = `${DRAFT_DISCLAIMER}
Thank you for your contribution!

This pull request appears to duplicate #${opts.canonicalNumber}.

${duplicateNotice}${confidenceNotice ? `\n${confidenceNotice}` : ""}
We are consolidating discussion and review on #${opts.canonicalNumber}.

<!-- EDIT: maintainer rationale or additional notes -->
`.trim();

  return {
    type: "duplicate_closure",
    itemNumber: opts.number,
    repo: opts.repo,
    subject,
    body,
    editableFields: extractEditableFields(body),
    disclaimer: DRAFT_DISCLAIMER,
  };
}

/**
 * Generate a closure comment when a PR or issue is superseded by another contribution.
 */
export function generateSupersededClosureComment(opts: {
  repo: string;
  number: number;
  title: string;
  supersededByNumber: number;
  supersededByTitle: string;
}): DraftComment {
  const subject = sanitizeTitle(opts.title || "");
  const supersededByTitleClean = sanitizeTitle(opts.supersededByTitle || "");

  const body = `${DRAFT_DISCLAIMER}
Thank you for your contribution!

This item has been superseded by #${opts.supersededByNumber} ("${supersededByTitleClean}").

Closing in favor of #${opts.supersededByNumber} so discussion and development remain consolidated.

<!-- EDIT: additional context or migration instructions for author -->
`.trim();

  return {
    type: "superseded_closure",
    itemNumber: opts.number,
    repo: opts.repo,
    subject,
    body,
    editableFields: extractEditableFields(body),
    disclaimer: DRAFT_DISCLAIMER,
  };
}

/**
 * Generate a comment requesting missing information from the contributor.
 */
export function generateMissingInfoRequest(opts: {
  repo: string;
  number: number;
  title: string;
  type: "pr" | "issue";
  missingItems: string[];
}): DraftComment {
  const subject = sanitizeTitle(opts.title || "");
  const itemTypeLabel = opts.type === "pr" ? "pull request" : "issue";
  const itemTypeShort = opts.type === "pr" ? "PR" : "issue";

  const missingList =
    opts.missingItems.length > 0
      ? opts.missingItems.map((item) => `- ${item}`).join("\n")
      : "- <!-- EDIT: specific missing information item -->";

  const body = `${DRAFT_DISCLAIMER}
Thanks for opening this ${itemTypeLabel}!

To help us review and triage this effectively, could you please provide the following missing information?

${missingList}

<!-- EDIT: specific details or questions for contributor -->

Once you've updated this ${itemTypeShort}, please let us know so we can take another look.
`.trim();

  return {
    type: "request_info",
    itemNumber: opts.number,
    repo: opts.repo,
    subject,
    body,
    editableFields: extractEditableFields(body),
    disclaimer: DRAFT_DISCLAIMER,
  };
}

/**
 * Generate a comment requesting missing automated tests on a PR.
 */
export function generateMissingTestsRequest(opts: {
  repo: string;
  number: number;
  title: string;
  changedFiles?: string[];
}): DraftComment {
  const subject = sanitizeTitle(opts.title || "");
  const changedFilesSection =
    opts.changedFiles && opts.changedFiles.length > 0
      ? `\nChanged files needing test coverage:\n${opts.changedFiles.map((f) => `- \`${f}\``).join("\n")}\n`
      : "";

  const body = `${DRAFT_DISCLAIMER}
Thanks for this pull request!

We noticed that this PR modifies codebase logic but does not include automated tests.
${changedFilesSection}
Could you please add tests covering the changes? Let us know if you have questions about how to structure tests or run the test suite.

<!-- EDIT: suggested test files or testing guidance -->
`.trim();

  return {
    type: "request_tests",
    itemNumber: opts.number,
    repo: opts.repo,
    subject,
    body,
    editableFields: extractEditableFields(body),
    disclaimer: DRAFT_DISCLAIMER,
  };
}

/**
 * Generate a structured change request comment from review findings.
 */
export function generateChangeRequest(opts: {
  repo: string;
  number: number;
  title: string;
  findings: Array<{ severity: string; description: string; fileOrSymbol?: string | null }>;
  reviewerNote?: string;
}): DraftComment {
  const subject = sanitizeTitle(opts.title || "");
  const findingsList =
    opts.findings.length > 0
      ? opts.findings
          .map(
            (f) =>
              `- [ ] **[${f.severity.toUpperCase()}]** ${f.fileOrSymbol ? `\`${f.fileOrSymbol}\`: ` : ""}${f.description}`,
          )
          .join("\n")
      : "- [ ] <!-- EDIT: requested change item -->";

  const noteSection = opts.reviewerNote ? `\n${opts.reviewerNote}\n` : "";

  const body = `${DRAFT_DISCLAIMER}
Thanks for your contribution! We reviewed the changes and identified the following items that need to be addressed before this can be merged:

### Requested Changes
${findingsList}
${noteSection}
<!-- EDIT: maintainer feedback and instructions for next iteration -->
`.trim();

  return {
    type: "change_request",
    itemNumber: opts.number,
    repo: opts.repo,
    subject,
    body,
    editableFields: extractEditableFields(body),
    disclaimer: DRAFT_DISCLAIMER,
  };
}

/**
 * Generate a summary review comment with recommendation, summary, and concerns.
 */
export function generateReviewSummary(opts: {
  repo: string;
  number: number;
  title: string;
  recommendation: string;
  summary: string;
  concerns: string[];
}): DraftComment {
  const subject = sanitizeTitle(opts.title || "");
  const concernsSection =
    opts.concerns.length > 0 ? `\n### Concerns & Notes\n${opts.concerns.map((c) => `- ${c}`).join("\n")}\n` : "";

  const body = `${DRAFT_DISCLAIMER}
## Code Review Summary

**Recommendation:** ${opts.recommendation}

${opts.summary}
${concernsSection}
<!-- EDIT: maintainer final assessment or approval conditions -->
`.trim();

  return {
    type: "review_summary",
    itemNumber: opts.number,
    repo: opts.repo,
    subject,
    body,
    editableFields: extractEditableFields(body),
    disclaimer: DRAFT_DISCLAIMER,
  };
}

/**
 * Generate an issue resolution comment with resolution details and related PR numbers.
 */
export function generateIssueResolution(opts: {
  repo: string;
  number: number;
  title: string;
  resolution: string;
  relatedPrNumbers?: number[];
}): DraftComment {
  const subject = sanitizeTitle(opts.title || "");
  const relatedPrSection =
    opts.relatedPrNumbers && opts.relatedPrNumbers.length > 0
      ? `\nResolved by pull request(s): ${opts.relatedPrNumbers.map((n) => `#${n}`).join(", ")}\n`
      : "";

  const body = `${DRAFT_DISCLAIMER}
Thank you for reporting this issue.

**Resolution:** ${opts.resolution}
${relatedPrSection}
<!-- EDIT: resolution explanation or release version details -->

Closing this issue as resolved. Feel free to comment if you continue to experience this problem.
`.trim();

  return {
    type: "issue_resolution",
    itemNumber: opts.number,
    repo: opts.repo,
    subject,
    body,
    editableFields: extractEditableFields(body),
    disclaimer: DRAFT_DISCLAIMER,
  };
}

/**
 * Generate a polite decline comment for an out-of-scope contribution.
 */
export function generateDeclineOutOfScope(opts: {
  repo: string;
  number: number;
  title: string;
  scopeExplanation?: string;
}): DraftComment {
  const subject = sanitizeTitle(opts.title || "");
  const explanationSection = opts.scopeExplanation ? `\n${opts.scopeExplanation}\n` : "";

  const body = `${DRAFT_DISCLAIMER}
Thank you for your contribution and interest in improving this project.

After review, we've decided not to move forward with this change as it falls outside the current scope and roadmap of the project.
${explanationSection}
<!-- EDIT: reason for declining and roadmap alignment explanation -->

We appreciate your effort and understanding.
`.trim();

  return {
    type: "decline_out_of_scope",
    itemNumber: opts.number,
    repo: opts.repo,
    subject,
    body,
    editableFields: extractEditableFields(body),
    disclaimer: DRAFT_DISCLAIMER,
  };
}
