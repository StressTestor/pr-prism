# pr-prism development notes

## architecture

### embedder singleton (v0.6)
single `EmbeddingProvider` instance created in `createPipelineContext()`, passed through `PipelineContext` to all pipeline functions. previously each command created its own embedder (sometimes 2-3 per run).

### shared similarity (v0.6)
`src/similarity.ts` exports `cosineSimilarity(ArrayLike<number>, ArrayLike<number>)` and `isZeroVector()`. used by both clustering and vision modules. accepts Float32Array and number[] via ArrayLike.

### json output schema (v0.6)
all commands support `--json` flag. outputs NDJSON (one JSON object per line) to stdout. each command has its own schema — scan outputs item objects, dupes outputs cluster objects, rank outputs scored PR objects, etc.

### public API (v0.7)
`src/index.ts` barrel export. pipeline functions (`runScan`, `runDupes`, `runRank`, `runVision`, `runReport`) are independently importable. `program.parse()` guarded by `isDirectRun` check so importing doesn't trigger CLI parsing.

### matryoshka truncation (v0.8)
`EMBEDDING_DIMENSIONS` env var. wrapper embedder in `createPipelineContext()` truncates vectors via `.slice(0, targetDims)` after generation. validates target <= model native dims. stored in `prism_meta` as both `embedding_dimensions` and native model dims.

### ANN pre-filtering (v0.8)
for datasets >= 5000 items, `findDuplicateClusters` uses `store.search()` (sqlite-vec ANN) to generate K=50 candidates per item, then verifies with exact cosine similarity. below 5000, brute-force O(n²) is fast enough.

### getAllEmbeddings JOIN (v0.8)
single `SELECT v.id, v.embedding FROM vec_items v INNER JOIN items i ON v.id = i.id WHERE i.repo = ?` replaces N individual getEmbedding calls.

## test coverage
78 tests across 11 files. key test files:
- `cluster-integration.test.ts` — BFS traversal, best-pick, zero-vector exclusion
- `store.test.ts` — upsert, dimension validation, read-only mode, getAllEmbeddings
- `scorer.test.ts` — weight redistribution, signal normalization
- `vision.test.ts` — boundary conditions for aligned/drifting/off-vision
- `similarity.test.ts` — cosine similarity edge cases, zero vectors

## version history
- v0.5.0 — publishable package, model tracking, re-embed, biome
- v0.6.0 — reliability (zero-vector handling, embedder singleton, backoff fixes), transparency (--explain, --json)
- v0.7.0 — testable architecture, public API, 78 tests
- v0.8.0 — performance (matryoshka truncation, ANN pre-filtering, JOIN query, configurable batch_size)
