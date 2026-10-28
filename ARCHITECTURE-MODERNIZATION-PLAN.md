# PR-Prism Architecture Inventory & Modernization Plan

## 1. Executive Summary

This document provides a comprehensive architectural inventory of the PR-Prism codebase at upstream baseline v4.0.0 (with the Node >=22 and TypeSafe Jev Phase 1 integration), along with a phased modernization proposal.

PR-Prism is a high-utility BYOK (Bring Your Own Key) tool for GitHub issue and PR triage, de-duplication, semantic ranking, and AI-assisted governance. Version 4.0.0 established essential mathematical and algorithmic correctness fixes:
1. **Normalized Vector Geometry**: L2 distance in `sqlite-vec` mapped to true cosine similarity on unit vectors (`1 - d^2 / 2`), guarded by on-disk vector geometry versioning.
2. **Exhaustive Duplicate Detection**: Elimination of premature candidate truncation at 5,000 items, replacing approximate KNN limits with exact pairwise cosine similarity and centroid re-absorption.
3. **Temporal Incident Windows**: Distinguishing repository-wide bulk closures from quality-based maintainer verdicts.
4. **Relational Classification**: Distinguishing issues from PRs and mapping closing edges.

The codebase now requires structural modernization to improve maintainability, domain separation, and developer velocity without compromising correctness or public contracts.

---

## 2. High-Priority Invariants

Any architectural refactoring **must** strictly preserve the following system invariants:

| Subsystem | Invariant Requirement |
| :--- | :--- |
| **Vector Geometry** | On-write unit-vector normalization (`toUnitVector`) and exact cosine derivation (`1 - d^2 / 2`). `vector_geometry_version` check on open. |
| **Clustering Accuracy** | Exact pairwise cosine similarity without truncation; connected components via BFS; centroid refinement with direct-edge re-absorption. |
| **Canonical Selection** | Unified candidate selection via `selectCanonical` respecting lifecycle state (merged > open > closed), CI veto, and incident-close tiers. |
| **Write Gates & Safety** | Default `dry-run` operation across CLI and GitHub App. No mutations (labels, comments, closes) unless explicit opt-in (`--apply-labels`, `PRISM_APPLY=true`). |
| **CLI & API Compatibility** | All Commander commands, options, exit codes, and public TypeScript exports (`src/index.ts`) must remain backward-compatible. |
| **Node.js Matrix** | Minimum Node.js `>=22.0.0`, recommended Node.js `24.x LTS`. Zero Node 20 backwards shims. |
| **Database Compatibility** | Zero breaking SQLite schema changes without automated migrations. Compatibility with `better-sqlite3` and `sqlite-vec`. |

---

## 3. Architecture Inventory (Baseline: 10 Target Modules)

Our codebase analysis examined the 10 largest and most critical source files (totaling 6,080 LOC):

| File | Lines | Primary Responsibilities | Structural Deficiencies |
| :--- | :---: | :--- | :--- |
| `src/cli.ts` | 1,369 | Commander command definitions, option parsing, interactive prompts, file I/O, doctor connectivity checks, markdown report generation. | **Severe SRP violation.** Mixes presentation, CLI routing, filesystem mutation, and report formatting. Untestable in isolation. |
| `src/pipeline.ts` | 900 | Pipeline orchestration, context creation, scan execution, duplicate clustering, ranking, vision check, diff comparison. | **Orchestration coupled with execution.** Pipeline stages mix batch database logic with terminal spinners (`ora`) and table printing. |
| `src/github.ts` | 747 | Octokit client wrapper, GraphQL PR/issue queries, REST fallbacks, diff fetching, label mutations, rate-limit telemetry. | **Mixed paradigms & responsibilities.** Combines GraphQL, REST, entity normalization, diff caching via store, write gating, and rate-limit state. |
| `src/store.ts` | 633 | SQLite database lifecycle, `sqlite-vec` extension, schema migrations, vector geometry verification, item CRUD, 3 distinct sub-caches. | **God Object.** `VectorStore` manages database lifecycle, vector algebra, schema migrations, entity storage, and cache persistence. |
| `src/benchmark.ts` | 594 | Benchmark CLI arguments, Ollama subprocess execution, isolated model DB paths, benchmark runner, Jaccard overlap math, table reporting. | **Mixed domains.** Combines process spawning (`ollama pull`), filesystem path math, statistical set math, and terminal formatting. |
| `server/scheduler.ts`| 494 | Node-cron scheduling, backlog scan window math, backlog scan execution, weekly digest date math, markdown report formatting. | **Duplicated reporting & mixed concerns.** Duplicates markdown table generation; mixes cron job lifecycle with GitHub sync workers. |
| `src/embeddings.ts` | 481 | Embedding interfaces, configuration validation, capability dictionaries, 5 concrete provider classes, text preparation. | **Violates Open-Closed Principle.** Adding or modifying an embedding provider requires editing a shared monolithic file. |
| `server/index.ts` | 341 | Hono web server, server config loading, private key loading, write-gated Octokit callbacks, webhook signature verification, route handling. | **Coupled server bootstrap.** Combines HTTP server lifecycle, route handlers, GitHub App auth callback factories, and webhook queue dispatch. |
| `src/cluster.ts` | 296 | Duplicate clustering options, item scoring (`scoreClusterItem`), pairwise cosine graph, BFS components, centroid refinement. | **Duplicated scoring.** Mirrors scoring logic from `scorer.ts`. (Algorithm itself is clean and mathematically sound). |
| `src/canonical.ts` | 225 | `CanonicalCandidate` interface, state priority, CI status veto, near-tie margin, deterministic canonical item selection. | **Exemplary cohesion.** Single-purpose, deterministic, clean pure functions. Serves as reference standard for refactoring. |

---

## 4. Key Architectural Findings & Violations

### 4.1 CLI Command Registration vs. Command Implementation
`src/cli.ts` contains 1,369 lines because it implements full business workflows inside `.action(async (opts) => { ... })` closures. For example, the `report` command contains over 260 lines of Markdown table formatting, and `init` contains 210 lines of interactive readline prompts and configuration string interpolation.

### 4.2 Pipeline Orchestration vs. Individual Stages
`src/pipeline.ts` defines `createPipelineContext` and orchestrates multi-stage triage (`scan` -> `dupes` -> `rank` -> `vision`), but also contains the full implementation of each stage. Furthermore, it directly imports and controls terminal formatting libraries (`chalk`, `ora`, `cli-table3`), making headless execution or programmatic API usage awkward.

### 4.3 GitHub API Boundary & Normalization
`src/github.ts` conflates data retrieval with entity normalization and mutation gating. GraphQL queries and REST queries produce different raw structures that are normalized ad-hoc. The write gate is instantiated inside `GitHubClient`, but also re-instantiated in `server/index.ts` and `src/pipeline.ts`.

### 4.4 SQLite Schema, Migrations, and Vector Geometry
`src/store.ts` handles:
1. Low-level SQLite Pragmas & `sqlite-vec` extension initialization.
2. High-level entity queries for items, diffs, reviews, and author counts.
3. Vector geometry versioning (`vector_geometry_version`) and normalization.
4. Three distinct cache tables (`diff_cache`, `reviews`, `author_cache`) that should be isolated repositories.

### 4.5 Embedding Provider Extensibility
`src/embeddings.ts` bundles `OpenAIEmbeddings`, `KimiEmbeddings`, `OllamaEmbeddings`, `VoyageEmbeddings`, and `JinaEmbeddings` into a single file. Each provider has different HTTP client nuances, base URL conventions, and error handling patterns.

### 4.6 Reporting Logic Duplication
Markdown triage report generation is duplicated across three separate locations:
1. `src/cli.ts` (`report` command)
2. `server/scheduler.ts` (`formatTriageReport`)
3. `server/format.ts` (`formatWeeklyDigest`, `formatComment`)

---

## 5. Target Architecture & Module Layout

The modernized architecture establishes clear domain boundaries, unidirectional dependencies, and single-purpose modules:

```
src/
├── cli/                          # CLI presentation layer
│   ├── index.ts                  # Commander command registration & routing only
│   ├── commands/                 # One file per CLI command
│   │   ├── init.ts
│   │   ├── doctor.ts
│   │   ├── scan.ts
│   │   ├── dupes.ts
│   │   ├── rank.ts
│   │   ├── vision.ts
│   │   ├── review.ts
│   │   ├── triage.ts
│   │   ├── compare.ts
│   │   ├── benchmark.ts
│   │   ├── store-mgmt.ts         # reset, re-embed, stats
│   │   └── report.ts
│   └── ui/                       # Terminal spinners, tables, error display
├── pipeline/                     # Pipeline orchestration layer
│   ├── context.ts                # PipelineContext factory
│   ├── orchestrator.ts           # Triage pipeline runner (event/result driven)
│   └── stages/                   # Isolated stage executions
│       ├── scan.ts
│       ├── cluster.ts
│       ├── rank.ts
│       ├── vision.ts
│       ├── compare.ts
│       └── re-embed.ts
├── github/                       # GitHub integration layer
│   ├── client.ts                 # Unified GitHubClient facade (preserves API)
│   ├── graphql/                  # GraphQL queries & cursor pagination
│   ├── rest/                     # REST fallbacks & file content fetches
│   ├── normalizers.ts            # Pure entity mapping (PRItem normalization)
│   ├── mutations.ts              # Write-gated label/comment/close operations
│   └── rate-limit.ts             # Telemetry & backoff tracking
├── store/                        # Storage & vector database layer
│   ├── vector-store.ts           # VectorStore facade (preserves API)
│   ├── connection.ts             # better-sqlite3 & sqlite-vec setup
│   ├── schema.ts                 # DDL, migrations & vector_geometry_version
│   ├── vector-math.ts            # toUnitVector, l2DistanceToCosine
│   ├── items-repo.ts             # PR/Issue storage & search
│   └── cache/                    # Isolated cache stores
│       ├── diff-cache.ts
│       ├── review-cache.ts
│       └── author-cache.ts
├── embeddings/                   # Embedding provider layer
│   ├── index.ts                  # createEmbeddingProvider factory
│   ├── types.ts                  # EmbeddingProvider contract
│   ├── format.ts                 # prepareEmbeddingText, hashing
│   └── providers/                # Pluggable provider implementations
│       ├── openai.ts             # OpenAI & OpenAI-compatible
│       ├── kimi.ts
│       ├── ollama.ts
│       ├── voyage.ts
│       └── jina.ts
├── decisions/                    # Typed decision layer (Phase 1)
│   ├── index.ts                  # createDecisionProvider factory & exports
│   ├── types.ts                  # Choice, Score, Noul contracts
│   ├── evaluator.ts              # Standard triage rubric evaluation
│   ├── sanitize.ts               # Untrusted text bounding & sanitization
│   ├── jev-provider.ts           # TypeSafe Jev SystemOne implementation
│   └── mock-provider.ts          # Deterministic test mock
├── reporting/                    # Shared reporting & markdown synthesis
│   ├── triage-report.ts          # Unified triage markdown report builder
│   ├── digest-report.ts          # Weekly digest markdown builder
│   └── tables.ts                 # Text & markdown table utilities
├── core/                         # Pure domain logic (no I/O, no network)
│   ├── cluster.ts                # Pairwise cosine graph, BFS, centroids
│   ├── canonical.ts              # Canonical candidate ranking & tiebreaks
│   ├── scorer.ts                 # Multi-signal PR quality scoring
│   ├── incident.ts               # Temporal incident window compiler
│   ├── bots.ts                   # Bot account detection
│   ├── relations.ts              # PR/Issue relationship classification
│   └── identity.ts               # Confirmed duplicate identification
└── types.ts                      # Core shared TypeScript contracts

server/                           # GitHub App webhook & scheduler service
├── index.ts                      # Process entry point & HTTP listener
├── app.ts                        # Hono app configuration & middleware
├── routes/                       # HTTP route handlers
│   ├── health.ts
│   ├── status.ts
│   └── webhook.ts
├── callbacks.ts                  # Write-gated GitHub App action callbacks
├── scheduler/                    # Scheduling & background tasks
│   ├── cron.ts                   # Cron job registry
│   ├── backlog-scanner.ts        # Repo backlog sync worker
│   └── weekly-digest.ts          # Digest generation & dispatch
├── config.ts                     # Server & repo configuration loading
└── db.ts                         # Server queue & repo status database
```

---

## 6. Phased Refactoring Roadmap

To ensure zero regressions, refactoring should proceed across distinct, independently testable phases:

### Phase 2A: Embedding Provider Modularization
- Split `src/embeddings.ts` into `src/embeddings/providers/*` and `src/embeddings/format.ts`.
- Maintain exact exports from `src/embeddings.ts` via re-exports.
- **Verification**: Run existing 30 tests in `openai-compatible-embeddings.test.ts` and 20 tests in `embeddings.test.ts`.

### Phase 2B: Storage Layer Decomposition
- Split `src/store.ts` into `src/store/connection.ts`, `src/store/schema.ts`, `src/store/vector-math.ts`, and cache sub-modules.
- Preserve the `VectorStore` class interface and `VECTOR_GEOMETRY_VERSION = "1"`.
- **Verification**: Run existing 25 tests in `store.test.ts` and 20 tests in `cluster-integration.test.ts`.

### Phase 2C: GitHub Client & Normalization Separation
- Extract pure normalizers (`accountIsBot`, `restPRState`, `mapClosingIssues`, `itemClosedAt`) to `src/github/normalizers.ts`.
- Separate GraphQL query strings and pagination into `src/github/graphql.ts`.
- **Verification**: Run existing 28 tests in `github.test.ts` and 9 tests in `relations.test.ts`.

### Phase 2D: CLI Decomposition & Reporting Consolidation
- Extract Commander command handlers from `src/cli.ts` into `src/cli/commands/*`.
- Consolidate Markdown report formatting into `src/reporting/triage-report.ts`, shared between CLI `report` and server `scheduler.ts`.
- **Verification**: Run existing 5 tests in `cli.test.ts`, 21 tests in `init.test.ts`, and full CLI `--help` checks.

### Phase 2E: Pipeline Stage Decoupling & Server Modularization
- Decouple pipeline stages from terminal output, allowing pipeline events to be subscribed to by CLI spinners or server logs.
- Modularize `server/index.ts` and `server/scheduler.ts`.
- **Verification**: Run all 37 test files (569 tests) and end-to-end webhook tests.

---

## 7. Risk Assessment & Mitigation

| Identified Risk | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **Circular Dependencies** | Runtime crash or initialization failure in ESM | Strict unidirectional layering: `core` -> `store`/`embeddings` -> `pipeline` -> `cli`/`server`. Enforce via Biome/ESLint dependency rules. |
| **Vector Geometry Regressions** | Inaccurate cluster generation; silent corruption | Pinned unit tests verifying `toUnitVector` and `l2DistanceToCosine`. Preserve `VECTOR_GEOMETRY_VERSION` guard. |
| **Accidental GitHub Mutations** | Spurious comments, labels, or closures on live repos | Write gates default to `dry-run` in both CLI and Server. Mandatory test verification of dry-run gates. |
| **Breaking Public Contracts** | Downstream consumers break upon import | Preserve `src/index.ts` re-exports for all legacy classes, types, and functions. |

---

## 8. Non-Goals

1. **No Micro-Module Proliferation**: Modules with strong cohesive logic (e.g., `src/canonical.ts`, 225 LOC) should not be split simply to satisfy arbitrary line limits.
2. **No Over-Abstraction**: Avoid excessive inheritance, generic visitor patterns, or dynamic dependency injection containers. Standard TypeScript modules and factory functions provide sufficient decoupling.
3. **No Database Engine Swapping**: Retain SQLite via `better-sqlite3` and `sqlite-vec`. Do not introduce heavyweight ORMs or external database dependencies.
4. **No Premature Feature Expansion**: Maintain strict focus on modularity, testing, and existing v4 capabilities before introducing new pipeline stages.
