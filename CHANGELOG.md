# changelog

all notable changes to pr-prism are documented here.

## [unreleased]

### added
- deterministic PR/issue relational classification via github closing edges (#20): the scan now fetches `closingIssuesReferences` per PR, and every cluster gets a `relation` label (`pr-issue-linked` / `pr-issue-unlinked` / `prs-only` / `issues-only`) plus resolved in-cluster `closingEdges`. flows into the starmap JSON (additive, schema stays v1), `dupes --json` NDJSON rows, `dupes --cluster` detail, and the report's verbose cluster section. `relation` is omitted for clusters holding pre-upgrade rows (unknown, never guessed)
- scan now refreshes metadata for unchanged items (ciStatus, reviewCount, labels, closesIssues) without re-embedding, so drifting signals stay current and existing dbs pick up closing refs on the next scan

## [3.0.2] — 2026-07-15

calibration pass driven by dogfooding a real duplicate cluster (odysseus #5207: bestPick was the closed, CI-failing PR over the merged green fix). two independent fixes so a red build can no longer win.

### changed
- canonical/bestPick selection now vetoes a red build: a PR with failing CI never outranks a same-state sibling with a non-failing build, regardless of quality score. stops a high-scored PR (e.g. one that added a test file) from being named bestPick over the green fix that actually landed, when the added test fails. only `ciStatus === "failure"` demotes, so a PR whose checks have not reported yet is never penalized; state (merged > open > closed) still dominates. starmap `canonical`/`contested` for such clusters shift accordingly (schema unchanged, still v1)
- the `hasTests` quality signal now requires a passing build: a PR with a failing build earns no test credit, since its added tests are not passing. this stops a scope-creep PR from inflating its rank by adding a test that fails. only a known-red build removes the credit (success/pending/unknown/absent keep it); the unknown-tests neutral is untouched. the merged-PR-is-canonical preference (state priority) already shipped in 3.0.0

## [3.0.1] — 2026-07-13

### fixed
- better-sqlite3 bumped 12.6.2 -> 12.11.1: node 26 dropped `info.This()` from V8 property callbacks, so 12.6.2 fails to compile from source. that broke the brew formula (builds against brew's node, now 26) and any npm install on node 26. 12.11.1 supports node through 26.x. suite verified green on node 26.5.0

## [3.0.0] — 2026-07-13

### breaking
- every github write (labels, comments, closes, issue creation) now funnels through one gate that defaults to dry-run. the CLI writes only under `--apply-labels`; the webhook server writes only when `PRISM_APPLY=1` is set. previously the server wrote unconditionally, and `--dry-run` still created missing labels. if you run the bot and want it to keep writing, set `PRISM_APPLY=1`

### added
- `prism dupes --starmap <path>`: stable JSON contract for external visualizers (schema v1, additive-only evolution). clusters carry confidence tiers, contested + runnerUp, tracker (original bug + role-tagged fix/duplicate candidates), item state (open/closed/merged), embedding model/dims/config hash, and github node ids
- confirmed-duplicate tier: PRs with the same head commit or an identical patch (git patch-id) group deterministically, above the embedding clusters. no similarity threshold involved
- `prism dupes --housekeeping <path>`: editable markdown manifest with the tracker issue, role-tagged candidates, paste-ready close text, and loose clusters flagged for review instead of a close directive. no auto-writes
- confidence tier on every cluster (high >= 90% / solid >= 80% / loose < 80%), keyed on minimum pairwise similarity, computed exactly (no sampling)
- contested flag: near-tied clusters (top-2 scores within 0.05) mark bestPick as needs-human and name the runnerUp
- `prism init` detects the repo from the git remote and writes it into config (`-r/--repo` override, `-y/--yes` non-interactive, `--no-verify`)

### changed
- one canonical selection everywhere: report, starmap, and the live bot use the same rule. issue-majority clusters resolve to the earliest report (the original bug), PR-majority to the highest quality item, and merged PRs are preferred over open ones
- fully deterministic output: same db in, same clusters, canonicals, and ordering out, run to run
- embedding text drops the "Pull Request:"/"Issue:" prefix so an issue and its fix PR embed identically (better recall). full re-embed (`prism reset` + `prism scan`) recommended; incremental scans warn on the text-version change
- centroid refinement no longer ejects a real duplicate that only pulled the centroid off-center
- npm package no longer ships compiled test files; build cleans `dist/` first so stale artifacts can't leak into a publish

### security
- every emitted title/theme is sanitized: control chars stripped, markdown table cells escaped. a hostile PR title can't inject table rows or terminal escapes
- CI and release workflow actions pinned to commit SHAs; releases publish with npm provenance

## [2.0.1] — 2026-07-09

### changed
- clean, actionable CLI error messages instead of raw stack traces on failures

### docs
- add ARCHITECTURE.md

## [2.0.0] — 2026-03-19

### added
- live triage bot: GitHub App that auto-triages new issues/PRs in real time
- webhook server (Hono) with GitHub signature verification
- per-repo sqlite-vec databases managed automatically
- dupe detection comments posted within seconds of issue being opened
- auto-close for obvious duplicates (>95% similarity, opt-in per repo)
- smart owner routing via CODEOWNERS file parsing
- weekly triage digest posted as GitHub issue every Monday
- backlog scan on App installation — full triage report on first install
- status endpoint: GET /status/:owner/:repo for health monitoring
- per-repo config via .prism.json (auto-close threshold, digest toggle, routing toggle)
- GitHub App installation token auth with 1-hour caching
- deployment scripts for Oracle ARM (systemd + nginx + Let's Encrypt)
- 88 new server tests (webhook, triage, DB, routing, config, auth, scheduler)

## [1.2.0] — 2026-03-17

### added
- `prism benchmark` command for A/B comparing embedding models on duplicate detection quality and speed
- cluster overlap computation using matched Jaccard index
- automatic Ollama model pulling when benchmarked model is not locally available
- multi-threshold support (test at 0.80, 0.82, 0.85, 0.87 to see where models diverge)

### changed
- default Ollama embedding model switched from `qwen3-embedding:0.6b` to `nomic-embed-text` (768 dims, 137M params). benchmarked at 791 items/min vs 214 for qwen3 (3.7x faster) with equal or better cluster detection on 10K items. existing installs with `EMBEDDING_MODEL=qwen3-embedding:0.6b` in .env are unaffected.

## [1.1.0] — 2026-03-17

### added
- `prism compare <n1> <n2>` command for pairwise similarity checking between any two PRs/issues
- GitHub Action (`action/action.yml`) for automated PR triage on pull_request and schedule events, posts duplicate warnings as PR comments
- Dockerfile for containerized usage
- author merge count cache in SQLite (24hr TTL) so repeat rank/triage runs skip GitHub API calls for known authors
- pipeline.ts module with extracted pipeline functions for programmatic use, enables Action and future integrations
- error tests for ProviderError, classifyFetchError, classifyHttpError (16 tests)
- reviewer tests for JSON parsing, empty responses, API errors, Zod validation, diff truncation (5 tests)
- pipeline tests for parseDuration and export verification (5 tests)

### fixed
- embedding API response validation: malformed responses now throw actionable ProviderErrors instead of crashing with TypeError
- LLM reviewer handles empty/refusal responses gracefully instead of crashing on `choices[0]`
- SQLite busy_timeout set to 5s so concurrent runs wait instead of crashing with SQLITE_BUSY
- Zod validation errors formatted as human-readable `path: message` lines (was raw Zod output)
- YAML parse errors caught and formatted (was raw stack trace)
- scoring DRY violation: cluster.ts now uses shared normalize functions from scorer.ts instead of inline reimplementations
- npm audit vulnerability resolved (rollup dev dep)

### changed
- pipeline functions moved from cli.ts to pipeline.ts (cli.ts is now a thin wrapper over commander commands)
- PipelineContext interface moved to types.ts
- normalizeDescriptionQuality and normalizeDiffSize exported from scorer.ts
- buildScorerContext accepts optional store/repo params for cache integration

## [1.0.0] — 2026-03-04

### added
- multi-repo support: `repos: [a/b, c/d]` config, cross-repo dupe detection
- per-repo vision docs: `vision_docs:` config field
- `prism stats` command with embedding coverage, model metadata, per-repo breakdown
- `prism review --top N` batch review mode
- `prism review --type issue` for issue reviews
- `prism review --show` for historical review lookup
- review storage in database (persists across sessions)
- `prism vision --stats` distribution histogram and section breakdown
- `prism vision --detail` per-item alignment table
- `--state all` on scan (open + closed)
- full `prism init` auto-detection (ollama models, env var API keys, best provider recommendation)
- embedding config hash tracking (warns on provider changes)
- cluster scoring upgrade: uses full quality signals (tests, CI, diff size, reviews, recency)

### changed
- README rewritten for v1.0 with badge row, quickstart, pipeline diagram, provider table
- `prism status` aliased as `prism stats`
- review command accepts optional number arg (was required positional)

## [0.9.0] — 2026-03-04

### added
- npm publish readiness (engines >= 20.0.0, prepublishOnly, files array)
- GitHub Actions CI pipeline (Node 20+22 matrix, build/lint/test/smoke)
- CHANGELOG.md, CONTRIBUTING.md
- unified error handling across all providers (ProviderError class)
- embedding progress persistence (crash recovery)
- `prism doctor` diagnostic command
- `prism init` with zero-cost setup guide
- `--top N` flag on triage
- `--output markdown` flag on dupes, vision, triage
- `dupes --cluster` shows available cluster IDs on invalid ID
- matryoshka benchmark (512 vs 1024 dims, 91.1% agreement)

### fixed
- Node 20 LTS compatibility (replaced import.meta.dirname with fileURLToPath)

## [0.8.0] — 2026-02-28

### changed
- parallel embedding batches with configurable concurrency
- GraphQL query optimization — reduced round-trips for large repos
- sqlite-vec ANN pre-filtering before exact cosine verification
- memory usage improvements for 5K+ item repositories

## [0.7.0] — 2026-02-27

### changed
- extracted CLI as thin wrapper over programmatic API
- full public API — scan, embed, cluster, rank, vision all importable
- 78 tests covering core pipeline
- `--json` flag on all commands for machine-readable output

## [0.6.0] — 2026-02-26

### added
- `--json` output on all commands
- transparent progress indicators during long operations

### fixed
- reliability improvements across embedding and scan pipelines
- better error messages on provider failures

## [0.5.0] — 2026-02-25

### added
- `files` array and `bin` field for npm packaging
- model tracking — detects embedding model mismatch and warns
- `prism embed --reset` to force re-embed
- biome for linting and formatting

### changed
- package restructured for publishability

## [0.4.1] — 2026-02-24

### changed
- default embedding model switched to `qwen3-embedding:0.6b` (smaller, faster)
- ollama batch size bumped to 50

## [0.4.0] — 2026-02-23

### added
- local ollama embedding support (mxbai-embed-large default)
- `prism embed --reset` for re-embedding

### changed
- default embedding provider changed from Jina to Ollama

## [0.3.0] — 2026-02-22

### changed
- GitHub ingestion rewritten from REST to GraphQL
- ~36 queries vs 14K+ REST calls for large repos
- scan pulls CI status, review counts, test detection, diff stats in one pass

## [0.2.0] — 2026-02-21

### fixed
- dead scoring signals (CI status, review counts were always 0)
- embedding dimension mismatch bugs
- added initial test coverage

## [0.1.0] — 2026-02-20

### added
- initial release
- scan, embed, dupes, rank, vision, triage pipeline
- Jina embeddings, OpenCode Zen for review
- sqlite + sqlite-vec storage
- zod-validated YAML config
- report command for markdown triage exports
