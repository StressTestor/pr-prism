# changelog

all notable changes to pr-prism are documented here.

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
