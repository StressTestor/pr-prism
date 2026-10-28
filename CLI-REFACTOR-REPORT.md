# CLI Architectural Refactor & Independent Audit Remediation Report

## 1. Original Responsibilities

Prior to this refactor, `src/cli.ts` was a 1,369-line monolithic file bundling disparate CLI concerns into a single module:
- **Global Command Registration:** Direct instantiation and registration of 14 commands (`init`, `doctor`, `scan`, `dupes`, `rank`, `vision`, `review`, `triage`, `compare`, `benchmark`, `reset`, `re-embed`, `stats`, `status`, `report`).
- **Mixed Business and Presentation Logic:** Review terminal rendering, spinner lifecycle orchestration, interactive prompt handling (via `readline`), and 150+ lines of Markdown report formatting lived inside command action blocks.
- **Top-level Side Effects on Import:** A regex/substring check (`process.argv[1]?.includes("prism")`) inadvertently triggered `program.parseAsync()` during unit testing whenever the worktree directory path contained `"prism"`, causing `src/__tests__/cli.test.ts` to inline helper functions rather than import `src/cli.ts`.
- **Untestable Handlers:** Command action handlers directly performed file I/O, process exits, and database queries without clear module seams, making unit and characterization testing difficult without network or disk mutations.

---

## 2. Final Directory Architecture

The CLI has been refactored into focused, cohesive, independently testable modules under `src/cli/` while preserving `src/cli.ts` as a 33-line thin executable entry point:

```
src/
  cli.ts                             # Thin executable entry point (delegates to createProgram(), handles canonical direct run)
  cli/
    program.ts                       # Factory function `createProgram()` configuring root Commander instance
    register-commands.ts             # Orchestrates registering all 14 commands
    commands/
      benchmark.ts                   # `prism benchmark` registration and action handler
      compare.ts                     # `prism compare <number1> <number2>` registration and handler
      doctor.ts                      # `prism doctor` health checks (config, env, GitHub token, DB, LLM)
      dupes.ts                       # `prism dupes` duplicate detection, cluster inspection, starmap & housekeeping
      init.ts                        # `prism init` configuration bootstrap, provider detection, setup verification
      rank.ts                        # `prism rank` PR quality scoring and ranking
      re-embed.ts                    # `prism re-embed` batch re-embedding of stored vectors
      report.ts                      # `prism report` triage report generation (JSON or Markdown)
      reset.ts                       # `prism reset` database removal with prompt confirmation
      review.ts                      # `prism review [number]` LLM review (single, batch, show)
      scan.ts                        # `prism scan` repository ingestion
      stats.ts                       # `prism stats` and `prism status` database & provider metrics
      triage.ts                      # `prism triage` end-to-end pipeline orchestration
      vision.ts                      # `prism vision` vision document alignment
    formatting/
      report.ts                      # Read-only `generateMarkdownReport()` renderer with store similarity dependency
      review.ts                      # `displayReview()` and review terminal presentation
    shared/
      paths.ts                       # Path utilities: `getPackageRoot()`, `getDataDir()`, `getDatabasePath()`
      prompts.ts                     # Interactive readline utilities: `askQuestion()`, `askConfirmation()`
      validation.ts                  # Option validation: `validateJsonOutputMutex()`
```

---

## 3. Rationale for Every Major Extraction

| Module / Extraction | Responsibility & Rationale |
|---|---|
| `src/cli/shared/paths.ts` | Centralizes package root and data directory resolution. Decouples modules from fragile relative `__dirname` navigation across build (`dist/`) and dev (`src/`) contexts. |
| `src/cli/shared/prompts.ts` | Extracts interactive `readline` lifecycle handling (`askQuestion`, `askConfirmation`) so prompts cleanly close I/O streams and can be injected with mock streams in unit tests. |
| `src/cli/shared/validation.ts` | Eliminates duplicated mutual exclusion validation (`--json` vs `--output`) used by `dupes` and `vision`. |
| `src/cli/formatting/review.ts` | Isolates terminal styling, color-coding (merge/revise/close), and confidence formatting for PR and issue reviews. |
| `src/cli/formatting/report.ts` | Read-only Markdown report renderer with storage dependencies (fetching vector embeddings to compute pairwise similarities against canonical source of truth for verbose cluster tables) without pipeline dependencies. |
| `src/cli/commands/*` | Encapsulates command-specific flags, descriptions, defaults, and action handlers. Ensures changes to one command cannot inadvertently leak or break others. |
| `src/cli/register-commands.ts` | Provides a single explicit registry of all CLI commands, allowing testing of command registration on fresh Commander instances. |
| `src/cli/program.ts` | Creates and configures the top-level Commander instance with package version, metadata, and registered commands. |
| `src/cli.ts` | Retained as a thin executable entry point with canonicalized entry-point identity detection (`isDirectRun()`) comparing `realpathSync(resolve(argv1))` to `realpathSync(fileURLToPath(metaUrl))` to eliminate false-positive argument parsing. |

---

## 4. Independent Audit Remediation Findings & Corrections

### Finding P1: Prevent Destructive Test Execution
- **Defect:** In `src/__tests__/cli-characterization.test.ts`, `runCli(["reset", "-y"])` defaulted to `rootDir` (`process.cwd()`), exposing real operator data in `data/prism.db` to unintended deletion during test runs.
- **Correction:**
  1. Replaced root-level execution with isolated temporary directories using `mkdtempSync(join(tmpdir(), "prism-reset-..."))`.
  2. Wrapped directory setup and teardown in `try/finally` with `rmSync(..., { recursive: true, force: true })`.
  3. Added tests for absent database handling in an isolated directory.
  4. Added fixture deletion tests against dummy `prism.db`, `prism.db-wal`, and `prism.db-shm` files.
  5. Verified that unrelated sentinel files inside and outside `data/` remain untouched during reset execution.
  6. Audited all other CLI tests to guarantee no mutating commands run against the repository root.

### Finding P2: Correct Direct-Run Entry-Point Detection
- **Defect:** In `src/cli.ts`, `isDirectRun()` previously used suffix/basename checks (`endsWith("cli.js") || basename(arg1) === "prism"`), which falsely triggered `program.parseAsync()` when an unrelated script named `cli.js` or `prism` imported `prism-triage/cli`.
- **Correction:**
  1. Replaced basename/suffix matching with canonicalized resolved path comparison:
     ```ts
     export function isDirectRun(
       argv1: string | undefined = process.argv[1],
       metaUrl: string = import.meta.url,
     ): boolean {
       if (!argv1 || !metaUrl) return false;
       try {
         const argPath = realpathSync(resolve(argv1));
         const selfPath = realpathSync(fileURLToPath(metaUrl));
         return argPath === selfPath;
       } catch {
         return false;
       }
     }
     ```
  2. Accounted for symlinks through `realpathSync`.
  3. Added dedicated test suite `src/__tests__/cli-direct-run.test.ts` covering all 7 audit-mandated scenarios:
     - Direct `node dist/cli.js --version`
     - Direct source execution using `tsx src/cli.ts --version`
     - Symlinked `prism` binary
     - Import from an unrelated script named `cli.js`
     - Import from an unrelated script named `prism`
     - Programmatic `createProgram()`
     - Safe module import without argument parsing

### Finding P2: Strengthen Behavioral Characterization
- **Defect:** Previous characterization tests concentrated on Commander option presence and help strings rather than end-to-end command execution contracts.
- **Correction:**Added `src/__tests__/cli-behavior.test.ts` (13 tests) exercising:
  - Serialization contracts (`doctor --json` schema validation with pass/fail/warn checks, `doctor` formatted terminal rendering).
  - Exit and failure semantics (`compare` missing args, `review` without target, `triage` invalid format, mutex enforcement in `dupes` and `vision`).
  - Read-only and dry-run defaults (`dupes`, `vision`, `triage`).
  - Markdown report generation features (non-verbose largest-cluster summary for groups >= 10, table cell row-injection escaping).
  - Working-directory and database path resolution using custom isolated directories.

### Finding P3: Report Formatter Cohesion
- **Defect:** `generateMarkdownReport()` was previously documented as pure, but reads vector embeddings from `VectorStore` to calculate pairwise similarity against the source of truth in verbose cluster details.
- **Correction:**Accurately documented `generateMarkdownReport()` as a read-only Markdown renderer with storage dependencies (`store.getEmbedding`), preserving the existing simple interface without unnecessary intermediate abstractions.

### Finding P3: Fix Report Provenance
- **Defect:** `CLI-REFACTOR-REPORT.md` had an amended commit SHA mismatch.
- **Correction:** Re-recorded all commit SHAs, documented exact reproduction results, and separated agent-reported results from independently reproducible instructions.

### Finding P2 (Final Remediation): Subprocess Environment Isolation & Credential Stripping
- **Defect:** In `src/__tests__/cli-behavior.test.ts`, doctor subprocesses inherited `process.env`. If a developer or CI environment had real credentials (`GITHUB_TOKEN`, provider keys) set in their shell, `doctor` would load them, attempt live network calls (e.g. `github.fetchPRs()`), and fail missing-credential assertions. Additionally, in-process tests using temporary `.env` fixtures could mutate `process.env` without cleanup.
- **Correction:**
  1. Created `src/__tests__/cli-test-env.ts` providing `getIsolatedEnv()`, `captureProcessEnv()`, and `restoreProcessEnv()`.
  2. `getIsolatedEnv()` strictly restricts environment variables to an allowlist of essential system runtime keys (`PATH`, `NODE`, `HOME`, `USER`, `TMPDIR`, etc.) and eliminates all tokens, credentials, and provider configurations (`GITHUB_*`, `GH_*`, `OPENAI_*`, `ANTHROPIC_*`, `EMBEDDING_*`, `LLM_*`, `PRISM_*`, etc.).
  3. Applied `getIsolatedEnv()` across all CLI subprocess test executions in `cli-behavior.test.ts`, `cli-characterization.test.ts`, and `cli-direct-run.test.ts`.
  4. Wrapped in-process `.env` fixture usage in `try/finally` with `restoreProcessEnv(testEnv)` and added suite-level `beforeEach`/`afterEach` environment reset hooks.
  5. Added regression tests proving that doctor subprocesses remain 100% offline and isolated even when fake credentials are intentionally injected into parent `process.env`, and that temporary `.env` fixtures never leak into other tests.

---

## 5. Files Changed

### Modified:
- `src/cli.ts` (canonicalized entry-point identity check, thin wrapper)
- `src/cli/formatting/report.ts` (clarified JSDoc for read-only renderer with storage dependencies)
- `src/__tests__/cli-behavior.test.ts` (subprocess environment isolation, parent credential regression test, fixture leak prevention)
- `src/__tests__/cli-characterization.test.ts` (isolated temporary directories for reset tests, sanitized subprocess environments)
- `src/__tests__/cli-direct-run.test.ts` (isolated subprocess environments)
- `src/__tests__/cli.test.ts` (direct verification of safe program export and factory instantiation)

### Created:
- `src/cli/program.ts`
- `src/cli/register-commands.ts`
- `src/cli/shared/paths.ts`
- `src/cli/shared/prompts.ts`
- `src/cli/shared/validation.ts`
- `src/cli/formatting/review.ts`
- `src/cli/commands/benchmark.ts`
- `src/cli/commands/compare.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/dupes.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/rank.ts`
- `src/cli/commands/re-embed.ts`
- `src/cli/commands/report.ts`
- `src/cli/commands/reset.ts`
- `src/cli/commands/review.ts`
- `src/cli/commands/scan.ts`
- `src/cli/commands/stats.ts`
- `src/cli/commands/triage.ts`
- `src/cli/commands/vision.ts`
- `src/__tests__/cli-test-env.ts`
- `src/__tests__/cli-behavior.test.ts`
- `src/__tests__/cli-direct-run.test.ts`
- `src/__tests__/cli-shared.test.ts`
- `src/__tests__/cli-formatting.test.ts`
- `src/__tests__/cli-utility-commands.test.ts`
- `src/__tests__/cli-pipeline-commands.test.ts`
- `src/__tests__/cli-core-commands.test.ts`

---

## 6. Tests Added & Complete Test Counts

Across 9 CLI test files, **77 CLI-specific tests** were written (and 617 total tests in the project suite):

| Test File | Test Count | Scope |
|---|---|---|
| `src/__tests__/cli-characterization.test.ts` | 24 tests | Version, root help, 14 command option signatures, mutex rules, isolated reset |
| `src/__tests__/cli-direct-run.test.ts` | 7 tests | Direct node, tsx, symlink, unrelated cli.js import, unrelated prism import, createProgram(), import safety |
| `src/__tests__/cli-behavior.test.ts` | 15 tests | JSON/text serialization contracts, exit handling, dry-run defaults, formatting edge cases, isolated cwd, parent credential isolation, .env leak prevention |
| `src/__tests__/cli-shared.test.ts` | 7 tests | Paths (`getPackageRoot`, `getDataDir`, `getDatabasePath`), prompts, validation |
| `src/__tests__/cli-formatting.test.ts` | 2 tests | Review terminal output, Markdown report generation |
| `src/__tests__/cli-utility-commands.test.ts` | 5 tests | `benchmark`, `compare`, `reset`, `re-embed`, `stats`/`status` registration |
| `src/__tests__/cli-pipeline-commands.test.ts` | 6 tests | `scan`, `dupes`, `rank`, `vision`, `triage` registration & validation |
| `src/__tests__/cli-core-commands.test.ts` | 4 tests | `init`, `doctor`, `review`, `report` registration |
| `src/__tests__/cli.test.ts` | 7 tests | `parseDuration` ISO output & error handling, safe program import & instantiation |
| **Total CLI Tests Added/Refined** | **77 tests** | |
| **Total Test Suite (incl. server & core)** | **617 tests (44 test files)** | **100% passing across Node 22 and 24** |

---

## 7. Exact Validation Results

### Node.js 24 Validation (`v24.22.0`)
```bash
$ npm run build
> prism-triage@4.0.0 build
> npm run clean && tsc -p tsconfig.build.json

$ npm run lint
> prism-triage@4.0.0 lint
> biome check src/
Checked 88 files in 56ms. No fixes applied.

$ npm run typecheck
> prism-triage@4.0.0 typecheck
> tsc --noEmit && tsc -p server/tsconfig.json --noEmit

$ npm test
> prism-triage@4.0.0 test
> vitest run
 Test Files  44 passed (44)
      Tests  617 passed (617)

$ npm run ci
4.0.0
Usage: prism [options] [command]
...

$ git diff --check upstream/main...HEAD
(clean, no output)
```

### Node.js 22 Validation (`v22.23.1`)
```bash
$ export PATH="/home/alteixeira20/.nvm/versions/node/v22.23.1/bin:$PATH"
$ node -v
v22.23.1
$ npm ci
added 156 packages, and audited 157 packages in 7s
$ npm run ci
Checked 88 files in 182ms. No fixes applied.
 Test Files  44 passed (44)
      Tests  617 passed (617)
4.0.0
Usage: prism [options] [command]
...
```

---

## 8. Behavior Compatibility Findings

- **Help and Option Signatures:** Fully preserved across all 14 commands and aliases (`stats` and `status`).
- **Defaults:** All option default values remain unchanged.
- **Exit Codes:** Clean exit code 0 on help/version/successful execution; exit code 1 on invalid arguments, mutex conflicts, and unhandled errors.
- **Output Formats:** JSON schema, NDJSON lines, and Markdown structure match original specifications.
- **Write Gating:** All write actions default strictly to dry-run unless `--apply-labels` is passed.
- **Programmatic Export:** `import { program, createProgram, isDirectRun } from "prism-triage/cli"` is safe and fully backward-compatible.
- **Test Isolation:** Subprocess tests strictly sanitize environment variables, guaranteeing offline and non-mutating execution regardless of host shell environment credentials.

---

## 9. Complete Commit List

1. `d6b17aa` test(cli): add characterization tests for CLI contract and flags
2. `21e0786` refactor(cli): extract shared cli utilities for paths, prompts and validation
3. `101f660` refactor(cli): extract formatting modules for reviews and markdown reports
4. `2d3d9cb` refactor(cli): extract benchmark, compare, reset, re-embed, and stats command modules
5. `65105c9` refactor(cli): extract scan, rank, vision, dupes, and triage command modules
6. `ad395d7` refactor(cli): extract init, doctor, review, and report command modules
7. `244c8f5` refactor(cli): modularize cli.ts into register-commands, program, and thin entry point
8. `c8aca98` test(cli): verify safe program import and factory instantiation in cli.test.ts
9. `1aaa7ac` fix(cli): isolate reset tests, harden direct-run entrypoint detection, and add behavioral tests
10. `d1e54c4` docs: update CLI refactor report with independent audit remediation
11. `fix(cli): isolate test subprocess environments and prevent credential leakage`

---

## 10. Final HEAD SHA

Branch `refactor/cli-command-modules` HEAD commit: `fix(cli): isolate test subprocess environments and prevent credential leakage`.

---

## 11. Final Verdict

**READY.** All audit findings (P1, P2, P3) including subprocess environment isolation, parent credential shielding, and `.env` fixture leakage prevention have been remediated, verified, and tested across both Node 22 and Node 24.
