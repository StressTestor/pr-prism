# changelog

all notable changes to pr-prism are documented here.

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
