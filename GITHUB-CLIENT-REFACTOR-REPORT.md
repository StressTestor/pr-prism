# PR-Prism GitHub Client Refactor Report

## 1. Executive Summary & Review Findings Resolution

Following an independent architectural review, all identified findings have been resolved without altering downstream contracts or introducing regressions:

- **P2-1 (Public Interface Facade Scope)**: `src/github.ts` previously re-exported `src/github/index.ts` via `export *`, which inadvertently exposed low-level GraphQL and REST operational helpers. The facade now re-exports **strictly** the historical public interface:
  - `GitHubClient` (class)
  - `FetchOptions` (type)
  - `restPRState` (function)
  - `itemClosedAt` (function)
  - `accountIsBot` (function)
  - `mapClosingIssues` (function)
  Runtime exports are verified by an exact array equality assertion in `src/__tests__/github-api-compat.test.ts`.
- **P2-2 (Write-Gate Regression Testing)**: Added comprehensive, deterministic write-gate characterization tests in `src/__tests__/github.test.ts` covering all three mutation methods:
  - `applyLabel`
  - `removeLabel`
  - `ensureLabel`
  Tests verify that in default `dry-run` mode, zero Octokit write methods (`addLabels`, `removeLabel`, `createLabel`) are executed, while `ensureLabel`'s read-only existence check (`getLabel`) is permitted. In `apply` mode, tests verify each mutation reaches the expected Octokit endpoint with exact parameters, avoiding redundant writes when labels already exist, and verifying no unexpected secondary mutations occur.
- **P3-1 (Documentation Accuracy & Verification Boundaries)**:
  - Corrected the public method inventory to accurately reflect **19 named public instance methods** (plus constructor) on `GitHubClient`.
  - Section 8 now explicitly separates **Verified Source Compatibility** (static signatures, types, parameter defaults, and zero consumer drift) from **Behavior Covered by Automated Tests** (mocked network flows, error classifications, retries, write gate guarding, diff caching).
- **P3-2 (REST Normalization Robustness)**: Documented the intentional robustness improvement in `normalizeRestPR` and `normalizeRestIssue`. Upstream baseline code called `pr.labels.map(...)` directly, which threw an unhandled `TypeError` on sparse synthetic objects missing the `labels` key. The refactored normalizer uses `pr.labels ? pr.labels.map(...) : []`, aligning REST with GraphQL (`(pr.labels?.nodes || []).map(...)`). This eliminates unhandled crashes on partial payloads without altering the mapped shape of standard GitHub API responses.

---

## 2. Original Responsibility Inventory

Prior to refactoring, `src/github.ts` was a monolithic 747-line module that combined multiple distinct operational and architectural responsibilities:

1. **Client Lifecycle & Instance Management**: Octokit instantiation, target repository state, write gate state, and lifecycle management.
2. **Authentication & Authorization**: Bearer token handling, token scope discrimination (403 permissions error vs. 403 rate-limit exhaustion).
3. **Transport & Network Execution**: Wrapping GraphQL and REST operations with backoff retries and empty response validation.
4. **Retry & Backoff Semantics**: HTTP 429 rate limit backoff (`retry-after` header parsing), HTTP 403 reset-based waiting, and transient error backoff (HTTP 500, 502, 503).
5. **Rate-Limit Accounting**: Parsing REST response headers (`x-ratelimit-*`), parsing GraphQL extension payloads (`extensions.rateLimit`), API call consumption estimation (`estimateAPICallsNeeded`), and warning threshold formatting (`formatRateLimitWarning`).
6. **GraphQL Query Definitions**: Embedding inline GraphQL document strings for PR fetching, issue fetching, and merged PR author counting.
7. **GraphQL Transport & Pagination**: Executing cursor-based pagination via `pullRequests` and `issues` fields, handling `pageInfo`, and managing early termination based on `maxItems` and `since` filters.
8. **REST Transport & Pagination**: Executing page-based pagination via `@octokit/rest` for PRs and issues, filtering non-issue PR entries, handling `per_page` clamping, and applying `maxItems` / `since` filters.
9. **Metadata Normalization**:
   - PR state normalization (`restPRState`: resolving merged vs. closed via `merged_at`).
   - Closed timestamp normalization (`itemClosedAt`: unifying REST `closed_at` and GraphQL `closedAt`).
   - Bot authorship detection (`accountIsBot`: handling GraphQL `__typename` vs. REST `type` without false-negative conversion for unknown users).
   - Closing issue reference resolution (`mapClosingIssues`: dropping cross-repository references and returning empty arrays).
   - CI status normalization (`mapCIStatus`: mapping GraphQL commit rollup and REST check run statuses).
   - Test file presence analysis (`hasTestFiles`, `determineHasTests`: identifying test files and applying 100-file threshold logic).
   - Item conversion (`normalizeGraphQLPR`, `normalizeGraphQLIssue`, `normalizeRestPR`, `normalizeRestIssue`).
10. **Diff Retrieval & Caching**: Retrieving Git diffs formatted as unified diffs, truncating diffs exceeding 500KB, and reading/writing to `VectorStore` cache.
11. **CI Check Status Aggregation**: Fetching PR head commit SHA and querying Check Runs via REST API.
12. **PR & Code Inspection**: Fetching single PR metadata (`getPR`), review counts (`fetchReviewCount`), changed file lists (`fetchChangedFiles`), and repository file contents (`fetchFileContent`).
13. **Write Operations & Write Gate Guarding**: Executing repository mutations (`applyLabel`, `removeLabel`, `ensureLabel`) guarded by `WriteGate` (dry-run vs. apply mode).

---

## 3. Final Module Structure

The client is decomposed into single-responsibility modules under `src/github/`, retaining `src/github.ts` as a strict compatibility facade:

```
src/
├── github.ts                              # Public compatibility facade (exact historical exports)
└── github/
    ├── types.ts                           # Internal & public options, context interfaces
    ├── rate-limit.ts                      # RateLimiter class (accounting, warnings, estimation)
    ├── retry.ts                           # withRetryBackoff implementation & transient error handling
    ├── normalization/
    │   ├── bot.ts                         # accountIsBot
    │   ├── ci.ts                          # mapCIStatus & mapCheckRunsToCIStatus
    │   ├── closed-at.ts                   # itemClosedAt
    │   ├── index.ts                       # Aggregated normalization exports
    │   ├── issues.ts                      # mapClosingIssues
    │   ├── items.ts                       # Pure PRItem builders (GraphQL PR, GraphQL Issue, REST PR, REST Issue)
    │   ├── pr-state.ts                    # restPRState
    │   └── test-files.ts                  # hasTestFiles & determineHasTests
    ├── graphql/
    │   ├── author.ts                      # getAuthorMergeCountGraphQL
    │   ├── index.ts                       # Aggregated GraphQL exports
    │   ├── issues.ts                      # fetchIssuesGraphQL
    │   ├── prs.ts                         # fetchPRsGraphQL
    │   └── queries.ts                     # PRS_QUERY, ISSUES_QUERY, AUTHOR_MERGE_COUNT_QUERY
    ├── rest/
    │   ├── author.ts                      # getAuthorMergeCount
    │   ├── content.ts                     # fetchFileContent
    │   ├── diff.ts                        # fetchDiff (caching & truncation)
    │   ├── index.ts                       # Aggregated REST exports
    │   ├── issues.ts                      # fetchIssues
    │   ├── labels.ts                      # applyLabel, removeLabel, ensureLabel (write gate guarded)
    │   └── prs.ts                         # fetchPRs, getPR, fetchReviewCount, fetchChangedFiles, fetchCIStatus
    ├── client.ts                          # GitHubClient class
    └── index.ts                           # Package root exports (for modular internal use)
```

---

## 4. Dependency Boundaries

The architecture enforces strict unidirectional dependency flow with zero circular dependencies:

```
                  ┌──────────────────────┐
                  │    src/github.ts     │ (Facade: 6 exact exports)
                  └──────────┬───────────┘
                             │ imports specific symbols
                             ▼
                  ┌──────────────────────┐
                  │  src/github/index.ts │
                  └──────────┬───────────┘
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
   ┌─────────────────┐ ┌───────────┐ ┌────────────────┐
   │    client.ts    │ │  retry.ts │ │ rate-limit.ts  │
   └────────┬────────┘ └───────────┘ └────────────────┘
            │
      ┌─────┴────────────────┐
      ▼                      ▼
┌───────────┐          ┌───────────┐
│ graphql/  │          │   rest/   │
└─────┬─────┘          └─────┬─────┘
      │                      │
      └──────────┬───────────┘
                 ▼
        ┌─────────────────┐
        │ normalization/  │
        └────────┬────────┘
                 ▼
        ┌─────────────────┐
        │    types.ts     │
        └─────────────────┘
```

- **Leaf Modules**: `src/github/types.ts` defines operational contracts (`GitHubContext`, `GitHubWriteContext`, `FetchOptions`, `CIStatus`).
- **Normalizers**: `src/github/normalization/*` are pure functions that have no dependencies on network clients or stateful instances.
- **Operations**: `src/github/graphql/*` and `src/github/rest/*` depend only on operational contexts, query constants, and normalizers.
- **Client Facade**: `GitHubClient` in `src/github/client.ts` wires the `RateLimiter`, `withRetryBackoff`, `WriteGate`, and operation functions through dynamic property context binding.

---

## 5. Refactoring Rationale

- **Cohesion**: Transport, queries, rate limiting, and normalizers are separated. Changes to GraphQL queries do not touch REST handling; normalizer bug fixes can be made and tested in pure isolation without mocking network requests.
- **Elimination of Duplication**: The previous monolithic `getPR` duplicated 25 lines of REST PR normalization logic from `fetchPRs`. Both now share the pure normalizer `normalizeRestPR`.
- **Testability**: Pure functions can be tested with plain JavaScript objects. Rate limiting and retries accept an optional mock clock function, enabling sub-millisecond execution of 5-stage backoff tests without `setTimeout` delays.
- **Safe Robustness**: Sparse synthetic payloads in REST paths safely default missing `labels` to `[]`, matching GraphQL behavior without breaking any valid API output.
- **No Circular Dependencies**: Submodules do not import from parent indices or from peer sub-packages (`graphql` does not import `rest`, `normalization` does not import `client`).
- **Strict Invariant Preservation**: Retains identical public API, method signatures, return types, error contracts, and runtime behavior.

---

## 6. Changed Files

### Modified Files
- `src/github.ts`: Replaced 747-line monolithic implementation with clean, backward-compatible facade exporting strictly `GitHubClient`, `FetchOptions`, `restPRState`, `itemClosedAt`, `accountIsBot`, and `mapClosingIssues`.
- `src/__tests__/github.test.ts`:
  - Updated `closedAt wiring` test to inspect `src/github/graphql/queries.ts` and `src/github/normalization/items.ts`.
  - Added comprehensive write-gate tests for `applyLabel`, `removeLabel`, and `ensureLabel` in both default dry-run and apply modes.

### Added Modular Implementation Files
- `src/github/types.ts`
- `src/github/rate-limit.ts`
- `src/github/retry.ts`
- `src/github/client.ts`
- `src/github/index.ts`
- `src/github/normalization/pr-state.ts`
- `src/github/normalization/closed-at.ts`
- `src/github/normalization/bot.ts`
- `src/github/normalization/issues.ts`
- `src/github/normalization/ci.ts`
- `src/github/normalization/test-files.ts`
- `src/github/normalization/items.ts`
- `src/github/normalization/index.ts`
- `src/github/graphql/queries.ts`
- `src/github/graphql/prs.ts`
- `src/github/graphql/issues.ts`
- `src/github/graphql/author.ts`
- `src/github/graphql/index.ts`
- `src/github/rest/prs.ts`
- `src/github/rest/issues.ts`
- `src/github/rest/diff.ts`
- `src/github/rest/labels.ts`
- `src/github/rest/content.ts`
- `src/github/rest/author.ts`
- `src/github/rest/index.ts`

### Added Test Files
- `src/__tests__/github-pagination.test.ts`
- `src/__tests__/github-retry.test.ts`
- `src/__tests__/github-rest.test.ts`
- `src/__tests__/github-normalization.test.ts`
- `src/__tests__/github-api-compat.test.ts`

---

## 7. Tests Added & Coverage Inventory

A total of 51 new tests were added across 5 new test files plus expansions in `src/__tests__/github.test.ts`:

1. **`src/__tests__/github.test.ts`** (30 tests, +2 comprehensive write-gate tests):
   - Default dry-run gate: asserts zero write calls (`addLabels`, `removeLabel`, `createLabel`) while allowing read-only lookup (`getLabel`).
   - Default dry-run gate: skips write when label already exists.
   - Authorized apply mode: verifies exact parameters for `applyLabel`, `removeLabel`, and `ensureLabel`, asserting zero unexpected additional writes.
   - Authorized apply mode: avoids `createLabel` when label already exists.
   - Characterization tests for `restPRState`, `mapCIStatus`, `hasTestFiles`, GraphQL mapping, `mapClosingIssues`, `accountIsBot`, `itemClosedAt`, and `closedAt wiring`.

2. **`src/__tests__/github-pagination.test.ts`** (7 tests):
   - GraphQL PR pagination across cursors (`hasNextPage`, `endCursor`).
   - GraphQL PR early exit on `maxItems`.
   - GraphQL PR early exit on `since` filter with progress notification.
   - GraphQL Issue pagination across cursors and states.
   - REST PR pagination with page numbering until empty page.
   - REST Issue filtering of embedded pull requests (`issue.pull_request`).
   - REST PR early exit on `since` filter.

3. **`src/__tests__/github-retry.test.ts`** (11 tests):
   - 403 token scope error immediately throws `ProviderError` (no retry).
   - 403 rate-limit exhaustion (`remaining === 0`) waits for `resetAt` and retries.
   - 429 rate-limit response parses `retry-after` header and retries.
   - 500, 502, 503 transient errors retry with incremental 5s backoff.
   - Exceeding 5 attempts throws transient error.
   - Empty/null API response throws `"API returned empty response"`.
   - GraphQL empty result or missing pullRequests error handling.
   - REST header rate-limit updates (`x-ratelimit-*`).
   - GraphQL extension rate-limit updates.
   - API call estimation (`estimateAPICallsNeeded`).
   - Rate limit warning formatting (`formatRateLimitWarning`).

4. **`src/__tests__/github-rest.test.ts`** (15 tests):
   - Diff retrieval via Octokit with `mediaType: { format: "diff" }` and store caching.
   - Diff retrieval returning cached diff from `VectorStore` without network call.
   - Diff truncation exceeding 500,000 characters with warning sentinel.
   - `fetchCIStatus` returning `"unknown"` for 0 check runs.
   - `fetchCIStatus` returning `"pending"` for incomplete check runs.
   - `fetchCIStatus` returning `"success"` when all check runs succeed.
   - `fetchCIStatus` returning `"failure"` when check runs fail.
   - `fetchCIStatus` returning `"unknown"` on network error.
   - `fetchFileContent` decoding base64 file contents.
   - `fetchFileContent` returning null on missing file or non-base64 encoding.
   - `fetchReviewCount` returning review count and handling failures.
   - `fetchChangedFiles` returning file list and handling failures.
   - `getAuthorMergeCount` querying search and handling failures.
   - `getPR` retrieving single PR and normalizing fields.
   - `removeLabel` swallowing 404 when label does not exist.

5. **`src/__tests__/github-normalization.test.ts`** (12 tests):
   - GraphQL PR normalization with missing optional fields.
   - GraphQL Issue normalization with missing fields.
   - REST PR normalization with string labels and deleted author.
   - REST Issue normalization with missing fields.
   - `restPRState` closed vs. merged distinctions with null/undefined `merged_at`.
   - `mapCIStatus` handling SUCCESS, FAILURE, ERROR, PENDING, EXPECTED, and null/undefined.
   - `mapCheckRunsToCIStatus` evaluating complex check run combinations.
   - `determineHasTests` 100-file threshold and undefined resolution.
   - `hasTestFiles` pattern detection.
   - `itemClosedAt` timestamp resolution.
   - `accountIsBot` unknown semantics (preserving `undefined` for missing accounts).
   - `mapClosingIssues` cross-repo reference dropping.

6. **`src/__tests__/github-api-compat.test.ts`** (4 tests):
   - Exact runtime facade exports validation on `src/github.ts` (0 leakage).
   - Module building block exports from `src/github/index.ts`.
   - Method presence and count check (exactly 19 named public instance methods).
   - Default rate limit and estimation helper initialization.

---

## 8. Preserved Behavior Contracts & Verification Separation

### Verified Source Compatibility (Static Code Contracts)
- **Class Constructor**: `new GitHubClient(token: string, owner: string, repo: string, gate: WriteGate = createWriteGate("dry-run"))`.
- **Exact Public Instance Methods (19)**:
  1. `getRateLimit(): RateLimitInfo`
  2. `withBackoff<T>(fn: () => Promise<T>): Promise<T>`
  3. `fetchPRsGraphQL(opts?: FetchOptions): Promise<PRItem[]>`
  4. `fetchIssuesGraphQL(opts?: FetchOptions): Promise<PRItem[]>`
  5. `getAuthorMergeCountGraphQL(author: string): Promise<number>`
  6. `fetchPRs(opts?: FetchOptions): Promise<PRItem[]>`
  7. `fetchIssues(opts?: FetchOptions): Promise<PRItem[]>`
  8. `getPR(prNumber: number): Promise<PRItem>`
  9. `fetchReviewCount(prNumber: number): Promise<number>`
  10. `fetchChangedFiles(prNumber: number): Promise<string[]>`
  11. `fetchDiff(prNumber: number, store?: VectorStore): Promise<string>`
  12. `fetchCIStatus(prNumber: number): Promise<"success" | "failure" | "pending" | "unknown">`
  13. `applyLabel(number: number, label: string): Promise<void>`
  14. `removeLabel(number: number, label: string): Promise<void>`
  15. `ensureLabel(label: string, color: string, description: string): Promise<void>`
  16. `getAuthorMergeCount(author: string): Promise<number>`
  17. `fetchFileContent(path: string): Promise<string | null>`
  18. `estimateAPICallsNeeded(totalPRs: number): number`
  19. `formatRateLimitWarning(estimatedCalls: number): string | null`
- **Facade Export Compatibility**: Exactly 5 runtime values (`GitHubClient`, `accountIsBot`, `itemClosedAt`, `mapClosingIssues`, `restPRState`) plus type `FetchOptions`.
- **Downstream Consumer Compatibility**: All existing imports in `cli.ts`, `pipeline.ts`, `benchmark.ts`, `labels.ts`, `scorer.ts`, and `server/scheduler.ts` compile without modification.

### Behavior Covered by Automated Tests (Dynamic Runtime Contracts)
- **Write Authorization Model**: Mutations (`applyLabel`, `removeLabel`, `ensureLabel`) remain strictly guarded by `WriteGate`. Dry-run mode never calls Octokit write endpoints.
- **Fallback Behavior**: Bulk scan and author search retain both GraphQL implementation and REST fallback.
- **Pagination Semantics**: Both cursor-based (GraphQL) and page-based (REST) pagination adhere to `maxItems` and `since` limits.
- **Error Classification**: 403 status discrimination (rate limit vs. token permissions) and 500/502/503 transient backoffs are preserved.
- **Metadata Nullability**: No unknown or missing fields are converted to false, zero, or empty strings unless explicitly required by upstream domain contracts (e.g. `accountIsBot` preserves `undefined` for deleted accounts).
- **Incident & Bot Wiring**: `closedAt` is queried in both GraphQL queries and hydrated at all 4 PRItem normalization sites.
- **Diff Caching & Truncation**: Cache hit returns immediately without Octokit call; uncached diffs truncate at 500KB and store in cache.

---

## 9. Complete Test Results

### Node 24 (v24.22.0)
- **Biome Linting**: `biome check src/` -> 88 files checked, 0 errors, 0 warnings.
- **TypeScript Typechecking**: `tsc --noEmit && tsc -p server/tsconfig.json --noEmit` -> 0 errors.
- **Vitest Test Suite**: 41 test files passed, 596 total tests passed (0 failed).
- **CLI Check**: `node dist/cli.js --version` (4.0.0) and `node dist/cli.js --help` succeeded.
- **Diff Hygiene**: `git diff --check upstream/main...HEAD` -> 0 errors.

### Node 22 (v22.23.1)
- **Native Rebuild**: `npm rebuild` executed cleanly with Node 22 headers.
- **Full CI Pipeline**: `npm run ci` succeeded cleanly with all 41 test files and 596 tests passing.

---

## 10. Cumulative Git Patch Summary

```text
 src/__tests__/github-api-compat.test.ts    |  70 +++
 src/__tests__/github-normalization.test.ts | 182 +++++++
 src/__tests__/github-pagination.test.ts    | 320 ++++++++++++
 src/__tests__/github-rest.test.ts          | 301 ++++++++++++
 src/__tests__/github-retry.test.ts         | 183 +++++++
 src/__tests__/github.test.ts               | 104 +++-
 src/github.ts                              | 759 +---------------------------
 src/github/client.ts                       | 147 ++++++
 src/github/graphql/author.ts               |  16 +
 src/github/graphql/index.ts                |   4 +
 src/github/graphql/issues.ts               |  48 ++
 src/github/graphql/prs.ts                  |  63 +++
 src/github/graphql/queries.ts              |  65 +++
 src/github/index.ts                        |  12 +
 src/github/normalization/bot.ts            |  13 +
 src/github/normalization/ci.ts             |  29 ++
 src/github/normalization/closed-at.ts      |   9 +
 src/github/normalization/index.ts          |  12 +
 src/github/normalization/issues.ts         |  13 +
 src/github/normalization/items.ts          |  97 ++++
 src/github/normalization/pr-state.ts       |   8 +
 src/github/normalization/test-files.ts     |  12 +
 src/github/rate-limit.ts                   |  56 +++
 src/github/rest/author.ts                  |  15 +
 src/github/rest/content.ts                 |  19 +
 src/github/rest/diff.ts                    |  35 ++
 src/github/rest/index.ts                   |  12 +
 src/github/rest/issues.ts                  |  44 ++
 src/github/rest/labels.ts                  |  65 +++
 src/github/rest/prs.ts                     | 116 +++++
 src/github/retry.ts                        |  62 +++
 src/github/types.ts                        |  25 +
 GITHUB-CLIENT-REFACTOR-REPORT.md           | 385 ++++++++++++++
 33 files changed, 2454 insertions(+), 757 deletions(-)
```

---

## 11. Final Self-Review & Verification

1. **No Out-of-Scope Modifications**:
   - `src/cli.ts` and `src/cli/**`: untouched
   - `src/decisions/**`: untouched
   - `src/config.ts`: untouched
   - `src/types.ts`: untouched
   - `src/index.ts`: untouched
   - `src/pipeline.ts`: untouched
   - `src/store.ts`: untouched
   - `package.json` & `package-lock.json`: untouched
   - `Dockerfile`, CI workflows, `README.md`, `ARCHITECTURE.md`: untouched
2. **Behavioral Invariants**: Confirmed 100% preservation of all public contracts, pagination, retry backoff, unknown semantics, and write authorization rules.
3. **No Live Mutations**: All testing utilizes mocked responses; zero live GitHub mutations executed.
4. **No AI Attribution**: Commit messages and metadata contain no AI co-author or attribution trailers.
5. **Node Multi-Version Compliance**: Validated cleanly on both Node 22.23.1 and Node 24.22.0.

---

## 12. Local Commit List & Final Commit SHA

The refactoring branch contains the following focused commits:
1. `d5b6bdb`: `refactor(github): decompose github client into modular architecture`
2. `9a9ef06`: `test(github): add comprehensive characterization tests for pagination, retries, and normalization`
3. `0032844`: `docs: add github client refactor report`
4. `fix(github): restrict facade exports and add comprehensive write-gate tests`

The final HEAD SHA on branch `refactor/github-client-modules` is obtained via `git rev-parse HEAD`.
