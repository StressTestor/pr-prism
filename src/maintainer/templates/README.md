# Maintainer Draft Templates System

This directory documents the deterministic maintainer draft templates system for PR-Prism v4 (`src/maintainer/drafts.ts`).

## Core Principles

1. **Deterministic & Pure (No LLM Calls)**
   All draft comment generators are pure TypeScript functions that compile structured input into Markdown text. No language model is ever invoked during draft generation. This ensures 100% predictable, reproducible outputs with zero hallucination risk.

2. **Maintainer Agency & Safety Invariants**
   - **Never auto-submits:** PR-Prism never submits comments or mutates repository state on GitHub without explicit human action.
   - **Advisory disclaimer:** Every draft comment includes an explicit header disclaimer:
     ```markdown
     <!-- DRAFT: Review and edit before submitting to GitHub. -->
     ```
   - **Human editable fields:** Placeholders in the format `<!-- EDIT: [field description] -->` mark locations requiring human context, maintainer judgment, or rationale.

3. **Grounding & Provenance Protection**
   - **Never invent artifacts:** Draft generators never invent PR numbers, commit hashes, filenames, test names, or maintainer decisions.
   - **Title & Input Sanitization:** All titles and external strings pass through `sanitizeTitle()`, which strips control characters (C0/C1, ANSI escapes) and caps length to protect against row/table injection and terminal corruption.
   - **Distinct Duplicate Signals:**
     - **Confirmed duplicates:** Identity clusters sharing an identical head commit OID or patch ID state: `"This is a confirmed duplicate (identical commit/patch)."`.
     - **Candidate duplicates:** Fuzzy embedding similarity clusters state: `"I've identified this as a likely duplicate based on semantic similarity. Please review both to confirm before closing."`.

---

## Template Catalog

The template engine supports 8 standard maintainer draft types (`DraftCommentType`):

| Type | Purpose | Primary Fields |
|---|---|---|
| `duplicate_closure` | Consolidate duplicate PRs/issues onto a canonical item | `canonicalNumber`, `isConfirmed`, `confidence` |
| `superseded_closure` | Close an item replaced by a newer PR or initiative | `supersededByNumber`, `supersededByTitle` |
| `request_info` | Ask contributor for reproduction steps, logs, or context | `type`, `missingItems` |
| `request_tests` | Request automated test coverage for modified code | `changedFiles` |
| `change_request` | Structure requested code modifications from review findings | `findings` (severity, description, file/symbol), `reviewerNote` |
| `review_summary` | Provide overall code review verdict and assessment | `recommendation`, `summary`, `concerns` |
| `issue_resolution` | Close an issue resolved by PRs or code fixes | `resolution`, `relatedPrNumbers` |
| `decline_out_of_scope`| Courteously decline contributions outside project goals | `scopeExplanation` |

---

## Draft Data Contract

Each generator returns a `DraftComment` object conforming to:

```typescript
export interface DraftComment {
  type: DraftCommentType;
  itemNumber: number;
  repo: string;
  subject: string;          // Sanitized PR/issue title
  body: string;             // Draft markdown text with disclaimer and placeholders
  editableFields: string[]; // List of placeholder fields extracted from the body
  disclaimer: string;       // "<!-- DRAFT: Review and edit before submitting to GitHub. -->\n"
}
```

The `editableFields` array is automatically extracted via `/<!-- EDIT: (.*?) -->/g`, enabling downstream tooling or maintainer UIs to highlight required human inputs before submission.
