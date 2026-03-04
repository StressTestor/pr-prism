# changelog

all notable changes to pr-prism are documented here.

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
