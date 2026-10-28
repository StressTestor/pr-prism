# AGENT-02 — PR-Prism v4: Jev Resolution Intelligence and Housekeeping

**Branch:** `feat/v4-jev-housekeeping`
**Report generated:** 2026-10-27T14:51:00Z
**Schema versions:** Relationship `1.0.0` · Resolution Questions `1.0.0` · Closure Evidence `1.0.0` · Priority Calibration `1.0.0` · Triage Plan `1.0.0`

---

## Executive Summary

All five task tracks delivered on `feat/v4-jev-housekeeping`. The new `src/housekeeping/` module adds:

- Indexed, non-quadratic relationship/duplicate candidate discovery (Task A)
- 9 typed Jev resolution questions + deterministic action-signal policy (Task B)
- 6-tier evidence-based closure verification with full provenance (Task C)
- Versioned P0 calibration with negative controls preventing false escalation (Task D)
- Priority-ordered triage plan with stable scheduler contract (Task E)

**Zero existing tests broken.** All 850 pre-existing tests continue to pass. 94 new tests added.

| Gate | Result |
|---|---|
| `vitest run` | ✅ 944/944 tests, 62 files |
| `tsc --noEmit` | ✅ 0 errors |
| `biome check src/` | ✅ 154 files clean |
| Existing Jev v2 data | ✅ Never overwritten |
| GitHub writes | ✅ None — read-only throughout |

---

## Baseline

| Metric | Count |
|---|---|
| Total stored items | 6,293 |
| Initially open items | 1,562 |
| Jev v2 decisions | 1,562 |
| Existing semantic duplicate clusters | 170 |
| Prior deep-review candidates | 891 |
| Items originally labeled P0 critical | 386 |
| Jev decomposed questions (pre-v4) | 14 |

---

## Task A — Candidate Relationship Discovery

**File:** [`src/housekeeping/relationship-discovery.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/housekeeping/relationship-discovery.ts)
**Tests:** [`src/__tests__/housekeeping-relationship-discovery.test.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/__tests__/housekeeping-relationship-discovery.test.ts) — **14 tests**

### Relationship types discovered

| Kind | Description |
|---|---|
| `IDENTITY_DUPLICATE` | Same `headRefOid` (deterministic) |
| `ALREADY_FIXED_CANDIDATE` | Open issue + merged PR with `closesIssues` reference |
| `CLOSES_REFERENCE` | PR has closing keyword → issue in scope |
| `CROSS_REFERENCE` | `#NNN` mention in body referencing in-scope item |
| `DUPLICATE_CANDIDATE` | Cluster-based embedding similarity, issue–issue |
| `SAME_UNDERLYING_PROBLEM` | Cluster-based, mixed PR+issue |
| `SUPERSEDED_CANDIDATE` | Older PR + newer open PR in same cluster |

### Evidence tiers

| Tier | Criteria |
|---|---|
| `DETERMINISTIC` | head-OID match |
| `STRONG` | merged PR + closing ref + matching files, or sim ≥ 0.85 + label overlap |
| `MODERATE` | sim ≥ 0.85 without additional signals, or cross-reference |
| `WEAK` | sim ≥ 0.72 only |
| `INSUFFICIENT` | below threshold |

### Algorithm properties

- **No all-pairs quadratic LLM comparisons.** Discovery is purely index-driven: head-OID index → closing-ref index → body cross-ref scan → cluster-scoped pairwise (bounded by cluster size, not N²).
- **No Jev calls inside this module.** `requiresJevValidation: true` is flagged for callers to orchestrate.
- All candidates carry `requiresHumanVerification: true`.
- Deduplication key: `repo:min(a,b)-max(a,b)-kind` with evidence-factor union across duplicate paths.
- Cross-repo closing edges are suppressed.
- Newer PRs are **not** automatically valid replacements — `SUPERSEDED_CANDIDATE` always sets `requiresJevValidation: true`.

---

## Task B — Jev Typed Resolution Questions

**File:** [`src/housekeeping/resolution-questions.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/housekeeping/resolution-questions.ts)
**Tests:** [`src/__tests__/housekeeping-resolution-questions.test.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/__tests__/housekeeping-resolution-questions.test.ts) — **25 tests**

### 9 decomposed resolution questions (extending existing 14 triage questions)

| Question | Type | Purpose |
|---|---|---|
| `same_underlying_problem` | noul | Same root cause/behavior despite different wording |
| `duplicate_candidate` | noul | Likely redundant with another known item |
| `already_resolved_candidate` | noul | Problem likely addressed by a merged fix |
| `superseded_candidate` | noul | Newer more complete implementation exists |
| `missing_information` | noul | Lacks required info to reproduce/review |
| `actionable` | noul | Maintainer can take concrete next action right now |
| `current_project_relevance` | score 0–3 | How relevant to current project goals |
| `code_review_complexity` | score 0–3 | Complexity of reviewing this change |
| `human_decision_required` | noul | Requires human policy judgment |

> **Note:** `code_review_complexity` measures review difficulty, not incident criticality. They are explicitly kept separate.

### Action signals (typed, deterministic policy — not free-form Jev text)

| Signal | Triggered when |
|---|---|
| `CLOSE_CANDIDATE` | duplicate_candidate ≥ 0.8 AND already_resolved ≥ 0.7 |
| `REQUEST_INFORMATION` | missing_information ≥ 0.75 AND actionable < 0.4 |
| `LIGHT_REVIEW` | complexity score ≤ 1 AND human_decision < 0.5 |
| `INTERMEDIATE_REVIEW` | complexity score = 2 |
| `COMPLEX_REVIEW_NEEDED` | complexity score = 3 (human/advanced AI warranted — **not** automatic LLM execution) |
| `MAINTAINER_DECISION` | any safety gate fired OR human_decision ≥ 0.7 |
| `READY_FOR_MAINTAINER` | default — actionable, no special routing |

`requiresHumanApproval: true` is a compile-time invariant — it cannot be false.

---

## Task C — Evidence-Based Closure Verification

**File:** [`src/housekeeping/closure-verification.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/housekeeping/closure-verification.ts)
**Tests:** [`src/__tests__/housekeeping-closure-verification.test.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/__tests__/housekeeping-closure-verification.test.ts) — **20 tests**

### 6-tier evidence classification

| Class | Meaning |
|---|---|
| `SUSPECTED_DUPLICATE` | Embedding similarity only, no other evidence |
| `STRONGLY_SUPPORTED_DUPLICATE` | Sim ≥ 0.85 + Jev noul ≥ 0.8 (or head-OID match) |
| `SUPERSEDED_BY_OPEN_ALTERNATIVE` | Newer open PR covers the same problem |
| `SUPERSEDED_BY_MERGED_REPLACEMENT` | Newer merged PR with closing reference |
| `ISSUE_RESOLVED_BY_MERGED_FIX` | Open issue + merged PR + closing reference |
| `UNRESOLVED_INSUFFICIENT_EVIDENCE` | Cannot classify confidently |
| `CLOSURE_VERIFIED` | All criteria met (see below) |

### CLOSURE_VERIFIED criteria (ALL required)

1. `evidenceClass` is `ISSUE_RESOLVED_BY_MERGED_FIX`, `SUPERSEDED_BY_MERGED_REPLACEMENT`, or `STRONGLY_SUPPORTED_DUPLICATE`
2. `closingEdgeConfirmed: true`
3. Jev decision noul ≥ 0.8 (duplicate OR already-resolved) OR head-OID match
4. `missingEvidence` array is empty

Even `CLOSURE_VERIFIED` candidates remain **pending maintainer approval**. `pendingMaintainerApproval: true` and `requiresManualVerification: true` are always set.

### Closure candidate export format

```typescript
interface ClosureCandidateExport {
  schemaVersion: string;
  generatedAt: string;
  repo: string;
  totalCandidates: number;
  verifiedCandidates: number;
  pendingManualReview: number;
  byEvidenceClass: Record<ClosureEvidenceClass, number>;
  candidates: ClosureCandidateRecord[];
}
```

---

## Task D — Priority Calibration

**File:** [`src/housekeeping/priority-calibration.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/housekeeping/priority-calibration.ts)
**Tests:** [`src/__tests__/housekeeping-priority-calibration.test.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/__tests__/housekeeping-priority-calibration.test.ts) — **18 tests**

### Calibrated priority bands

| Band | Meaning |
|---|---|
| `P0_OPERATIONAL_CRITICAL` | Immediate incident / data loss with high urgency |
| `P0_SECURITY_CRITICAL` | Confirmed security vulnerability / privacy breach |
| `P1_HIGH_REVIEW` | Complex/risky but NOT urgent operational incident |
| `P1_INFORMATION_NEEDED` | Missing description/info before any action |
| `P2_INTERMEDIATE_REVIEW` | Non-trivial, bounded risk |
| `P3_LIGHT_REVIEW` | Routine, low-risk |
| `P3_CLOSURE_CANDIDATE` | Likely redundant |
| `P4_STALE_OR_IRRELEVANT` | Stale or out of scope |

### Calibration dimensions

- **defectImpactIfReal** — production impact if the underlying defect is real
- **defectRealityConfidence** — probability confidence the defect is real
- **urgency** — immediate action needed right now?
- **changeComplexity** — complexity of proposed change
- **reviewNecessity** — review is required before merge/close?
- **verifiedFindingSeverity** — only set when evidence is verified

### Negative controls (prevent false P0 escalation)

| Control | Effect |
|---|---|
| `isRoutineDocsOrTests` | Suppresses review-complexity escalation for docs/tests with no safety gates |
| `hasOnlyGenericSecurityKeywords` | Suppresses P0 escalation when "security"/"auth" appear but no gate fired and security noul < 0.5 |
| `isBotOrCiNoise` | Caps at P2_INTERMEDIATE_REVIEW |

### Non-overridable safety gates (unchanged from existing design)

- `safety_gate:security_vulnerability` AND `defectRealityConfidence ≥ 0.7` → `P0_SECURITY_CRITICAL`
- `safety_gate:data_loss` AND `urgency ≥ 0.8` → `P0_OPERATIONAL_CRITICAL`

### Before/after P0 calibration

> **Limitation:** Exact before/after counts require running calibration over all 1,562 live Jev v2 decision records, which requires a live database. The calibration functions are validated and deterministic — run `calibratePriorityBand` over all existing records to produce the live analysis.

**Original P0 count (from baseline):** 386

**Expected calibration effects:**
- Items that were P0 solely due to high `code_review_complexity` (without safety gates or verified urgency) → downgraded to `P1_HIGH_REVIEW`
- Items with generic security keywords (no gate fired, low security noul) → downgraded to `P2_INTERMEDIATE_REVIEW` or `P3_LIGHT_REVIEW`
- Documentation/test PRs with no safety gates → downgraded to `P3_LIGHT_REVIEW`
- Bot-authored items → capped at `P2_INTERMEDIATE_REVIEW`
- Items with `safety_gate:security_vulnerability` AND confirmed high confidence → retained as `P0_SECURITY_CRITICAL`

The `originalBand` field is always preserved in `CalibratedPriorityRecord`. The original Jev v2 database is never modified.

---

## Task E — Efficient Routing and Triage Plan

**File:** [`src/housekeeping/triage-plan.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/housekeeping/triage-plan.ts)
**Tests:** [`src/__tests__/housekeeping-triage-plan.test.ts`](file:///home/alteixeira20/Projects/pr-prism-v4-jev-housekeeping/src/__tests__/housekeeping-triage-plan.test.ts) — **17 tests**

### Priority ordering (reproduced in output)

1. `CLOSURE_CANDIDATES` — verified closure candidates for maintainer approval
2. `INFORMATION_REQUESTS` — items needing more info
3. `LIGHT_REVIEW` — routine low-risk
4. `INTERMEDIATE_REVIEW` — non-trivial, bounded complexity
5. `COMPLEX_REVIEW_NEEDED` — human/advanced AI review warranted (**not** automatic LLM execution)
6. `MAINTAINER_DECISION` — requires human policy judgment
7. `READY_FOR_MAINTAINER` — queued, actionable, no special routing

### Estimated routing counts

> **Limitation:** Live routing counts require all 1,562 Jev v2 decisions + calibration to be run through `buildTriagePlan`. The functions are validated; sample estimates below are illustrative based on baseline distributions.

| Group | Estimated count (indicative) |
|---|---|
| CLOSURE_CANDIDATES (verified) | ~15–40 (deterministically verified only) |
| CLOSURE_CANDIDATES (unverified) | ~130–200 |
| INFORMATION_REQUESTS | ~80–150 |
| LIGHT_REVIEW | ~200–350 |
| INTERMEDIATE_REVIEW | ~150–250 |
| COMPLEX_REVIEW_NEEDED | ~200–400 |
| MAINTAINER_DECISION | ~50–100 |
| READY_FOR_MAINTAINER | remainder |

> These are estimates only. Actual review-call avoidance is reported only for **verified** closure candidates with deterministic evidence. Unverified candidates are not counted.

### Review-call avoidance accounting

`estimatedReviewCallAvoided: true` is set **only** for `CLOSURE_CANDIDATES` where `closureCandidateVerified === true`. All other entries carry `estimatedReviewCallAvoided: false`. The triage plan disclaimer:

> "Estimated avoided review calls are based only on closure candidates with deterministic verification evidence. Unverified closure candidates are not counted."

### Stable scheduler contract

```typescript
// Consumed by review scheduler after integration
interface TriagePlan {
  schemaVersion: "1.0.0";
  schedulerContractVersion: "1.0.0";
  generatedAt: string;
  repo: string;
  summary: TriagePlanSummary;
  entries: TriagePlanEntry[];
}
```

Both `schemaVersion` and `schedulerContractVersion` are stable — the review scheduler can version-gate on `schedulerContractVersion`.

---

## New Files Delivered

```
src/housekeeping/
├── index.ts                      — barrel export for all housekeeping modules
├── relationship-discovery.ts     — Task A: indexed candidate discovery
├── resolution-questions.ts       — Task B: 9 typed Jev questions + action signals
├── closure-verification.ts       — Task C: 6-tier closure evidence verification
├── priority-calibration.ts       — Task D: versioned P0 calibration layer
└── triage-plan.ts                — Task E: priority-ordered routing + scheduler contract

src/__tests__/
├── housekeeping-relationship-discovery.test.ts   — 14 tests
├── housekeeping-resolution-questions.test.ts     — 25 tests
├── housekeeping-closure-verification.test.ts     — 20 tests
├── housekeeping-priority-calibration.test.ts     — 18 tests
└── housekeeping-triage-plan.test.ts              — 17 tests
```

**Total new tests:** 94
**Total test suite:** 944 passing (0 failures)

---

## Versioned Schema Summary

| Schema | Version | Location |
|---|---|---|
| Relationship discovery | `1.0.0` | `RELATIONSHIP_SCHEMA_VERSION` in `relationship-discovery.ts` |
| Resolution questions | `1.0.0` / rubric `v1` | `RESOLUTION_QUESTIONS_SCHEMA_VERSION` in `resolution-questions.ts` |
| Closure evidence | `1.0.0` | `CLOSURE_EVIDENCE_SCHEMA_VERSION` in `closure-verification.ts` |
| Priority calibration | `1.0.0` | `PRIORITY_CALIBRATION_SCHEMA_VERSION` in `priority-calibration.ts` |
| Triage plan | `1.0.0` | `TRIAGE_PLAN_SCHEMA_VERSION` / `TRIAGE_SCHEDULER_CONTRACT_VERSION` in `triage-plan.ts` |
| Existing Jev v2 decisions | `2.0.0` | `JEV_FIRST_SCHEMA_VERSION` in `triage-v2.ts` (unchanged) |

---

## Unresolved Evidence Limitations

1. **Live P0 calibration counts** require running `computeCalibrationDimensions` + `calibratePriorityBand` over all 1,562 live Jev v2 records. The database path must be provided by the caller.

2. **Embedding similarity** between arbitrary item pairs is only available within existing clusters. Items that were not embedded or clustered cannot participate in similarity-based relationship discovery.

3. **Merged PR history** beyond what is stored in the SQLite store (merged/closed state, closesIssues) is not available without a live GitHub API call. The relationship discovery engine uses only stored item state.

4. **Changed files and code ownership** fields are not present in all items (depends on scan scope). `sharedChangedFiles` in candidates will be empty when neither item has changedFiles data.

5. **Jev resolution questions** (Task B) require a live TypeSafe API key to evaluate. The question definitions and action-signal policy are ready; evaluation must be orchestrated by callers with the Jev provider configured.

6. **Cross-repository closing references** are explicitly suppressed (by design) — same-repo verification only.

7. **Stale item detection** (`P4_STALE_OR_IRRELEVANT`) uses `updatedAt` age as a proxy; items may be stale in intent but recently updated (e.g., bot-bumped). Human verification is always required.

---

## What Was Not Done (Out of Scope)

- No modification to `src/deep-reviewer.ts`, `server/scheduler.ts`, or maintainer UI/reporting files.
- No modification to the existing Jev v2 decision database (`jev_decisions` table) or `triage-v2.ts` question definitions.
- No GitHub API writes, comments, or closures — PR-Prism remains read-only throughout.
- No automatic GLM/LLM execution — `COMPLEX_REVIEW_NEEDED` is a typed signal, not an execution directive.
- No merge, push, or deployment to any environment.
