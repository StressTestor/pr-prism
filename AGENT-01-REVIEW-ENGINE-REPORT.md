# AGY 01 — PR-Prism v4: Reliable Tiered Review Engine Report

**Author / Role:** Review Inference, Provider Adapters, Output Validation, Token Budgets & Multi-Account Scheduling Engine Agent
**Worktree:** `~/Projects/pr-prism-v4-review-engine`
**Branch:** `feat/v4-review-engine`
**Timestamp:** 2026-10-27
**Status:** Completed & Validated (Full CI Passed: 58 test files, 905/905 tests passing, zero lint/type errors)

---

## 1. Executive Summary & Defect Diagnosis

### 1.1 Existing Defect Analysis
A previous smoke test using Featherless Developer subscriptions against `zai-org/GLM-5.3-Flash` processed three items across three accounts:
- **PR #6357**: Stored as empty JSON object `{}`.
- **Issue #1940**: Stored as empty JSON object `{}`.
- **Issue #6224**: Stored as `{ rawContent: "..." }` placeholder.

All three jobs consumed exactly **4,096 completion tokens** and were reported as "completed" by the scheduler.

### 1.2 Root Cause Identification
1. **Hardcoded Token Ceiling (`max_tokens: 4096`)**:
   In `src/deep-reviewer.ts`, inference requests were hardcoded to `max_tokens: 4096`. For reasoning-enabled architectures like `zai-org/GLM-5.3-Flash`, the model consumed tokens on internal chain-of-thought, hitting the 4,096 ceiling before completing the required JSON payload. The provider set `finish_reason: "length"`.
2. **Naive Parser Fallback**:
   In `src/review-scheduler.ts` (`defaultExecuteJob`), when `JSON.parse` encountered truncated JSON, it fell back to `parsed = { rawContent: content }`, or defaulted `content || "{}"` to an empty object.
3. **Absence of Validation at Persistence Boundary**:
   The scheduler immediately called `completeJobWithCheckpoint()` regardless of whether the output was substantive, truncated, or empty. A raw HTTP 200 was treated as sufficient to mark the job `completed`.
4. **Classification Flaw (`classifyProviderError`)**:
   Local `ZodError` or schema validation exceptions were checked via `name === "ZodError"` inside the `request_rejected` branch. This mistakenly categorized client-side validation failures as permanent provider 400/422 rejections (`rejected_permanent`), permanently blocking retry across alternative accounts or tiers.

---

## 2. Architecture & Technical Remediations

### 2.1 Task A: Strict Review Validation (`src/review/validation-error.ts`)
- **Explicit Error Taxonomy**: Introduced `ReviewValidationError` with discrete failure kinds:
  - `truncated_generation`: `finish_reason === "length"`.
  - `empty_result`: Empty object `{}` or `null`/`undefined`.
  - `rawcontent_placeholder`: Upstream JSON extraction failures.
  - `schema_mismatch`: Missing required substantive fields (`summary`, `findings`, `recommendation` for PRs; `summary`, `issueAction`, `validityAssessment` for Issues).
- **Validation Boundary**: Enforced via `validateReviewResult()` before invoking `queue.completeJobWithCheckpoint()`.
- **Classification Repair**: Model output flaws are categorized as `transient_error` (retryable up to `maxAttempts`), reserving `request_rejected` strictly for HTTP 400/422 and provider content-policy rejections.
- **Provenance Accounting**: Checkpoints now capture:
  - `finish_reason`: Provider-reported termination signal.
  - `recorded_model_id`: Actual model ID reported in response body.
  - `prompt_fingerprint` & `response_fingerprint`: 16-character SHA-256 digests.
  - `evidence_completeness`: Flagged as `"full"`, `"partial"`, or `"minimal"`.
  - `checkpoint_status`: Distinguishes valid `"completed"` reviews from quarantined `"invalid"` entries.
- **Historical Quarantine**: Implemented `quarantineSmokeTestCheckpoints()` in `DurableReviewQueue` and `--quarantine-smoke-test` in the CLI to isolate the historical failures (`PR #6357`, `Issue #1940`, `Issue #6224`) into `"invalid"` status without touching the canonical 891-item queue.

### 2.2 Task B: Review Tiers & Model Registry (`src/review/model-registry.ts`)
Configured the initial Featherless models with explicit context, budget, and concurrency invariants:

| Tier | Model ID | Provider | Concurrency Units | Context Window | Max Output Budget | Concurrency / Account | Policy |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **LIGHT** | `Qwen/Qwen3-Coder-30B-A3B-Instruct` | Featherless | 1 | 32,768 | 8,192 | 2 concurrent | Non-exclusive |
| **INTERMEDIATE** | `zai-org/GLM-4.7-Flash` | Featherless | 2 | 202,752 | 8,192 | 2 concurrent | Non-exclusive |
| **COMPLEX** | `zai-org/GLM-5.3-Flash` | Featherless | 4 | 262,144 | 12,288 | 1 concurrent | **Exclusive** (no concurrent overlap) |

- **Reasoning Effort Control**: Configurable `reasoningEffort` for `GLM-5.3-Flash` (default `"low"` to prioritize grounded completion tokens over unobserved reasoning consumption).
- **Model Availability Gate**: `validateModelAvailability()` queries the provider endpoint (`/models/{modelId}`) before inference.
- **Model Substitution Guard**: The system never silently substitutes a model.

### 2.3 Task C: Multi-Account Durable Scheduling (`src/review-scheduler.ts`)
- **Capacity & Lease Management**:
  - Supports up to 5 concurrent account profiles (`MAX_PROVIDER_ACCOUNTS = 5`).
  - Strict account-level capacity tracking: LIGHT/INTERMEDIATE support up to 2 concurrent requests, while COMPLEX is strictly exclusive (1 active job per account).
  - Global active job cap (`maxActiveJobs`) across all accounts.
- **Durable State Invariants**:
  - SQLite WAL mode with immediate transactions and retry on lock.
  - Automatic column migration for older review database schemas.
  - Dynamic lease heartbeats (`heartbeatLease()`) and crash recovery (`recoverExpiredLeases()`).
  - Secret protection: Only 12-character SHA-256 key fingerprints (`keyFingerprint`) are emitted in logs, reports, and ledgers.
- **Error Handling**: Exponential backoff on HTTP 429, account quarantine on 401/402/403, and per-account usage ledger accounting.

### 2.4 Task D: CLI Interface & Batch Control (`src/cli/commands/review.ts`)
Integrated operational controls into `prism review`:
- `--dry-run`: Reports matching jobs, estimated token requirements, and tier routing without initiating LLM API calls or mutating the database.
- `--max-jobs <N>`: **Critical Safety Gate**. Enforces a hard stop after exactly N completed reviews, preventing accidental runaway paid batches.
- `--tier <light|intermediate|complex>`: Overrides model tier routing.
- `--status`: Inspects durable queue metrics, active leases, account utilization, and recent failures without inference.
- `--account-stats`: Outputs aggregated request, token, and error statistics per account.
- `--resume`: Resumes processing from the queue, preserving immutable valid checkpoints.
- Filtering options: `--prs-only`, `--issues-only`, `--open-only`.
- Pre-flight checks: `--verify-accounts`, `--verify-models`.
- Administrative: `--quarantine-smoke-test`.

### 2.5 Task E: Review Quality, Untrusted Data Boundary & Secret Redaction
- **Boundary Defusing**: Untrusted GitHub PR/Issue titles, bodies, and diffs are wrapped in `<UNTRUSTED_GITHUB_DATA label="...">` blocks with defused closing tags to prevent prompt injection.
- **Diff Grounding**: PR reviews require grounded evidence quoting diff hunks with file/symbol references. Confidence is capped at `0.65` if diff context is missing or truncated.
- **Issue Invariant**: Issue reviews use dedicated triage actions (`confirm_bug`, `needs_reproduction`, etc.) and are strictly barred from emitting PR merge recommendations.
- **Secret Redaction**: `redactSecretsFromText()` strips Bearer tokens, GitHub PATs (`ghp_`, `gho_`), OpenAI/Featherless keys (`sk-`), AWS access keys (`AKIA...`), and PEM private keys from diff and body content prior to provider transmission.
- **Read-Only Gate**: GitHub client instances are verified via `assertReadOnlyGitHubClient()` to guarantee zero unauthorized mutations (no labels, comments, or closes).

---

## 3. Verification & Test Evidence

### 3.1 Test Suite Summary
Vitest regression test suite:
- **Test Files**: 58 passed (100%)
- **Tests**: 905 passed (100%)
- **Duration**: ~5.6s
- **Zero Failures, Zero Flaky Tests**

### 3.2 Key Test Coverage in `src/__tests__/review-engine-v4.test.ts`
1. **Empty & Malformed Completions**:
   - Rejects `{}` empty object (`empty_result`).
   - Rejects `null`/`undefined`.
   - Rejects `{ rawContent: ... }` placeholder (`rawcontent_placeholder`).
   - Rejects missing `summary` field.
   - Rejects missing `issueAction` on issue reviews.
   - Accepts minimal valid PR and Issue reviews.
2. **`finish_reason=length` Truncation**:
   - Classifies `length` as `truncated_generation`.
   - Proves scheduler does not record truncated outputs as completed checkpoints.
   - Re-queues truncated generations as retryable `transient_error`.
   - Full reproduction of the 4,096-token failure case.
3. **Token Budget Configurations**:
   - LIGHT verified at 8,192 tokens.
   - INTERMEDIATE verified at 8,192 tokens.
   - COMPLEX verified at 12,288 tokens.
   - Verified `max_tokens` and `reasoning_effort` are transmitted in request bodies.
4. **Schema Enforcement**:
   - PR schema validation: `summary`, `findings[]`, `concerns[]`, `recommendation`, `confidence`.
   - Valid recommendations: `merge`, `revise`, `close`, `needs_human_review`.
   - Issue schema validation: `summary`, `issueAction`, `validityAssessment`, `confidence`.
   - Proves Issue reviews reject PR merge recommendations.
5. **Concurrency & Isolation**:
   - Two accounts never claim the same job simultaneously.
   - Independent lease tracking per account.
   - Account A failure does not release Account B lease.
   - Disabled accounts do not stall active accounts.
   - Isolated usage ledgers per account.
6. **Mixed Model Tiers**:
   - LIGHT processes with 1 concurrency unit.
   - INTERMEDIATE processes with 2 concurrency units.
   - COMPLEX allows max 1 concurrent job and blocks second overlapping job on the same account.
7. **Capacity Limits & Safety Gates**:
   - Rejects configuration exceeding 5 accounts.
   - Enforces global `maxActiveJobs` limit.
   - Enforces `--max-jobs N` hard stop for bounded smoke tests (tested for N=1, N=2, N=3).
8. **Failure Recovery & Idempotency**:
   - Transient errors increment attempt counters.
   - Rejection after exceeding `maxAttempts`.
   - Exponential backoff on rate limits.
   - Duplicate prevention on identical fingerprints.
   - Expired lease recovery and resume from crash.
9. **Write Gate Protection**:
   - Confirms zero GitHub mutations are attempted during review execution.

---

## 4. Machine-Readable Review-Tier Contract

Exported from `src/review/tier-contract.ts` for integration with the Jev agent:

```json
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-10-27T14:45:00.000Z",
  "tiers": [
    {
      "tier": "light",
      "modelId": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "provider": "featherless",
      "contextTokens": 32768,
      "maxOutputTokens": 8192,
      "concurrencyUnits": 1,
      "maxConcurrentPerAccount": 2,
      "exclusivePerAccount": false
    },
    {
      "tier": "intermediate",
      "modelId": "zai-org/GLM-4.7-Flash",
      "provider": "featherless",
      "contextTokens": 202752,
      "maxOutputTokens": 8192,
      "concurrencyUnits": 2,
      "maxConcurrentPerAccount": 2,
      "exclusivePerAccount": false
    },
    {
      "tier": "complex",
      "modelId": "zai-org/GLM-5.3-Flash",
      "provider": "featherless",
      "contextTokens": 262144,
      "maxOutputTokens": 12288,
      "concurrencyUnits": 4,
      "maxConcurrentPerAccount": 1,
      "exclusivePerAccount": true
    }
  ],
  "concurrencyPolicy": {
    "maxAccountsSupported": 5,
    "defaultMaxConcurrentPerAccount": 1,
    "lightMaxConcurrent": 2,
    "intermediateMaxConcurrent": 2,
    "complexMaxConcurrent": 1,
    "complexIsExclusive": true
  }
}
```

---

## 5. Operational Guide & CLI Examples

### 5.1 Inspect Queue Status (No Inference)
```bash
node dist/cli.js review --queue-db ./data/prism-review.db --status
```

### 5.2 Dry-Run Batch Simulation
```bash
node dist/cli.js review --queue-db ./data/prism-review.db --dry-run --tier complex --max-jobs 5
```

### 5.3 Quarantine Historical Smoke Test Checkpoints
```bash
node dist/cli.js review --queue-db ./data/prism-review.db --quarantine-smoke-test
```

### 5.4 Execute Bounded Smoke Test (Max 3 Jobs)
```bash
node dist/cli.js review --queue-db ./data/prism-review.db --max-jobs 3 --tier complex
```

### 5.5 Resume Queue (Skip Completed Checkpoints)
```bash
node dist/cli.js review --queue-db ./data/prism-review.db --resume --tier intermediate
```

---

## 6. Known Limitations & Next Steps

1. **Provider Metadata Cache**: `validateModelAvailability()` queries the provider endpoint once per account during pre-flight. Future iterations can add local TTL caching (e.g., 1 hour) to reduce metadata round-trips.
2. **Dynamic Reasoning Budget Allocation**: Currently, `reasoningEffort: "low"` is static for `GLM-5.3-Flash`. If high-complexity architectural PRs require deeper chain-of-thought, dynamic tier elevation can be coordinated with the upstream Jev triage agent.
3. **Branch Invariant**: Working branch is `feat/v4-review-engine`. No canonical merges or push actions were performed. Full 891-item production batch remains safely unlaunched.
