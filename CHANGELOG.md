# changelog

all notable changes to pr-prism are documented here.

## [4.0.0] - 2026-07-30

### upgrading

**your existing database will refuse to search until you convert it.** vectors are now
normalised on write and similarity is derived as `1 - d^2/2`, so a store written by 3.x holds
raw vectors that the new formula would read as confidently wrong similarities. `search()` throws
with an actionable message rather than answering. two ways out:

```
prism re-embed          # re-embeds and stamps the new geometry
```

or call `backfillVectorGeometry()` to normalise in place without re-embedding, which is fast and
does not touch your provider.

**cluster counts change enormously.** on a 5285-item corpus at the same 0.85 threshold, 26
clusters became 501. that is the bug below being fixed, not a threshold change. anything
consuming the JSON, or acting on the counts, will see roughly 20x more clusters from the same
input. any cluster count you recorded from 3.x on a corpus of 5000+ items is not comparable.

**breaking API changes** for anyone importing the library rather than using the CLI:

- `RepoConfig` gains required `incidents` and `cluster`
- `WeeklyDigestConfig` loses `similarityThreshold` and `autoClose` (the first is now read per
  repo, the second had no reader)
- `itemMetadata()` returns a named `ItemMetadata` type instead of `Record<string, unknown>`
- `VectorStore`'s fourth constructor argument is an options object
- `statePriority()` ranks four tiers instead of three

### fixed

- **duplicate detection was finding a fraction of the duplicates on any corpus of 5000+ items.**
  three compounding bugs. the `vec0` table is declared without a distance metric, so sqlite-vec
  returns L2, but `store.search` filtered `1 - distance >= threshold`, which is not cosine at any
  scale. nothing normalised vectors on write, so that conversion was not valid to attempt anyway.
  and `cluster.ts` routed 5000+ items through a candidate-limited path that passed the clustering
  threshold into that same wrong-scale filter, then truncated whatever survived to K=50. measured
  on a real 5285-item corpus: **26 clusters found where exact pairwise finds 501**, and the
  "optimisation" was *slower* (20.6s against 9.3s). vectors are normalised on write, similarity is
  derived, and the candidate-limited path is gone: `vec0` KNN is itself a full scan with a `LIMIT`,
  so there was never an index to approximate with. closes #19
- the webhook path no longer overwrites what a scan learned. `server/triage.ts` wrote
  `metadata: { author, state }` wholesale, and because `upsert` replaces `metadata_json` outright,
  a `pull_request.opened` webhook draining after a backlog scan dropped every other field the scan
  had stored (labels, diff size, ci status, closing refs, `authorIsBot`). it now writes only the
  fields the event can actually observe and leaves the rest of the row alone
- the weekly digest reads per-repo settings instead of a global copy. it was passed
  `DEFAULT_REPO_CONFIG.similarityThreshold` and clustered *every* repo at the default, ignoring
  whatever that repo had configured, so its cluster counts disagreed with the backlog scan's for
  the same repo
- one unusable `config.json` no longer aborts the whole installation loop. a repo whose config
  cannot be honoured is skipped loudly and by name; the repos after it in the list still get
  scanned

### changed

- incident-closed PRs rank *between* open and closed rather than as fully open. an item closed by
  a repository-wide event never got a maintainer verdict, so it outranks a deliberate close, but it
  is not evidence of live work the way an open PR is. on the corpus this was built for the tiers
  are 993 open / 1347 merged / 2945 closed, so promoting a ~900-item incident to open-equivalent
  roughly doubled the tier the ranking exists to order
- bot-authored items are excluded from clustering by default. automation reuses titles for
  unrelated content, so consecutive bot PRs embed as near-identical and surfaced as duplicates
  nobody could act on. set `cluster.include_bot_authors: true` to restore the old behaviour, or
  list repo-specific automation under `cluster.bot_authors`. applies to confirmed (identity)
  clusters and to the App's webhook triage, which previously commented on a bot's PR telling it
  the bot had duplicated itself
- the server/GitHub-App path honours incident windows and the `cluster` block, declared per repo
  in that repo's `config.json`. key names follow each file's own convention: the CLI's yaml uses
  `cluster.bot_authors` / `cluster.include_bot_authors`, the App's json uses `cluster.botAuthors` /
  `cluster.includeBotAuthors`. closes #27
- confirmed (identity) duplicate clusters pick canonical by earliest-created instead of quality
  score: byte-identical duplicates are a which-was-first question, and a copied PR can outscore the
  original it was lifted from. fuzzy clusters keep the state/CI/score rule

### added

- incident-aware ranking. `prism.config.yaml` accepts an `incidents:` list of
  `{start, end, reason}` windows. a repository-wide event (visibility flip, bulk close, migration)
  closes items for reasons unrelated to their quality, and because `selectCanonical()` ranks
  lifecycle state before score, those items sank below genuinely-closed siblings, inverting triage
  order for exactly the backlog a maintainer needs. `closedAt` is captured from both API paths and
  stored in `metadata_json` (no schema migration); `incidentClosed` is derived at read time, so
  correcting a window is a config edit rather than a rescan. window bounds require an explicit UTC
  offset and are rejected at load if unparseable or inverted, because an offset-less timestamp
  parses in the host timezone and would select different PRs on a laptop than in CI
- starmap carries `incidentClosed: true` on items *and* on every reference to them (canonical,
  runnerUp, partition, tracker ref and candidates), omitted when false. a consumer contract has to
  accept it in all of those positions
- starmap items carry `createdAt` alongside `updatedAt`, so consumers can reason about
  which-was-first without re-fetching from github
- scans record `authorIsBot` from github's own account type (graphql `__typename`, rest
  `user.type`) rather than guessing. rows scanned before this field fall back to a login check, so
  bot filtering works without a rescan
- `prism benchmark --out <path>` writes a run's results to a chosen file. every run previously
  wrote `data/benchmark-results.json`, so a second run silently destroyed the first one's numbers
- `prism benchmark --include-bot-authors` clusters bot-authored items too, since the benchmark has
  no `prism.config.yaml` in scope and could otherwise only ever measure the filtered default
- benchmark results record `clusterMembership` per model per threshold. cluster counts cannot tell
  you whether a model finding more clusters is catching real duplicates or chaining unrelated
  items, and re-deriving membership means re-embedding the whole corpus
- embedding models that expect an instruction prefix get one (`embeddinggemma`).
  `EMBEDDING_TEXT_VERSION` bumps to 3 so prefixed and unprefixed vectors cannot be mixed. measured
  effect on clustering for this workload: none, kept because it is what the model documents

### for contributors

- `server/scheduler.ts` builds stored metadata with the shared `itemMetadata()` instead of its own
  literal, which had drifted behind by three fields
- a backlog scan fetches closed items only for repos that declare an incident window, bounded by
  the earliest window start. open and closed are fetched separately because `since` aborts a fetch
  at the first item older than it, so bounding a combined `state:"all"` call would drop untouched
  open PRs
- note for existing installs: rows scanned before this release carry no `closedAt`, and a default
  scan fetches open items only. run `prism scan --state all` after an incident, or the window
  matches nothing. this is per-incident, not a one-time backfill

## [3.1.0] — 2026-07-20

### added
- OpenAI-compatible endpoint support (#17, PR #18 by @alteixeira20): optional `EMBEDDING_BASE_URL` / `LLM_BASE_URL` route the generic `openai` provider at any compatible service (featherless.ai tested), with URL validation (http/https only, credentials/query/fragment rejected), explicit `EMBEDDING_DIMENSIONS` for unknown models, response-index and vector validation, API-key redaction in provider errors, endpoint fingerprints instead of raw URLs in hashes and db names, a real embedding probe in `doctor`/`init`, and `benchmark --provider/--base-url/--dimensions`
- provider-selected dimensional reduction gets a distinct versioned vector-space identity in the embedding config hash; legacy local truncation and native output keep their established hashes
- deterministic PR/issue relational classification via github closing edges (#20): the scan now fetches `closingIssuesReferences` per PR, and every cluster gets a `relation` label (`pr-issue-linked` / `pr-issue-unlinked` / `prs-only` / `issues-only`) plus resolved in-cluster `closingEdges`. flows into the starmap JSON (additive, schema stays v1), `dupes --json` NDJSON rows, `dupes --cluster` detail, and the report's verbose cluster section. `relation` is omitted for clusters holding pre-upgrade rows (unknown, never guessed)
- scan now refreshes metadata for unchanged items (ciStatus, reviewCount, labels, closesIssues) without re-embedding, so drifting signals stay current and existing dbs pick up closing refs on the next scan

### changed
- scan now fails closed when the embedding configuration changes while the db still holds vectors from the previous space (was a warning that let mixed vector spaces accumulate). remedy: `prism re-embed` or `prism reset`

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
