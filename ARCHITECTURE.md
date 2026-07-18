# architecture

## overview

pr-prism is a triage tool for repos drowning in PRs. CLI scans GitHub, embeds items locally, clusters duplicates, ranks by quality signals, checks vision alignment, and runs LLM reviews. optional webhook server for automated triage on new PRs.

## stack

| layer | technology | version |
|-------|-----------|---------|
| language | TypeScript | 5.x |
| runtime | Node.js | 22+ |
| CLI framework | Commander.js | 13.x |
| database | better-sqlite3 + sqlite-vec | 12.x / 0.1.x |
| embeddings | ollama, jina, openai, voyage, kimi | multi-provider |
| LLM | openai, anthropic, kimi, opencode, ollama | multi-provider |
| HTTP server | Hono | 4.x |
| GitHub auth | @octokit/rest + @octokit/auth-app | - |
| scheduler | node-cron | 4.x |
| test | vitest | 3.x |
| lint | biome | 1.x |
| config | zod + yaml | - |

## directory structure

```
src/                    # CLI tool (published to npm as prism-triage)
  cli.ts                # CLI entry point, command definitions
  init.ts               # `prism init` logic: git-remote repo detect/inject + post-init verify (testable, extracted from cli)
  pipeline.ts           # orchestrates scan -> embed -> cluster -> score -> vision -> review
  github.ts             # GraphQL + REST client, rate limiting, backoff
  embeddings.ts         # 5 embedding providers, batch processing, dimension detection
  store.ts              # SQLite + sqlite-vec, schema migrations, dimension validation
  cluster.ts            # cosine similarity, BFS clustering, duplicate detection; scoreClusterItem() shared scorer
  canonical.ts          # selectCanonical()/decideCanonical() source-of-truth pick (merged preferred) + contested; selectTracker() original-bug + fix/duplicate candidates
  identity.ts           # findConfirmedDuplicates(): deterministic non-embedding dupe tier (same head-oid / patch-id)
  relations.ts          # classifyClusterRelation(): deterministic member-relationship label per cluster (pr-issue-linked/-unlinked via github closing edges, prs-only, issues-only) + resolved in-cluster closingEdges; relation omitted when any member PR predates the closesIssues scan field (absent = unknown, never "closes nothing")
  similarity.ts         # ANN pre-filtering, matryoshka truncation
  sanitize.ts           # title/theme emit sanitizer: strip control/ANSI, escape markdown table cells (row-injection defense)
  scorer.ts             # 7 quality signals: tests, CI, diff size, author history, etc. hasTests credit is gated on CI (a red build earns no test credit - failing tests are not coverage)
  starmap.ts            # stable star-map JSON contract: clusters + minSim/confidence/partition/contested+runnerUp + tracker(original bug + fix/duplicate candidates) + item state (open/closed/merged) + relation/closingEdges/closes (deterministic, from relations.ts) + embeddingModel/provider/dims/configHash + node ids + (repo,number) join key
  housekeeping.ts       # editable markdown manifest: tracker + paste-ready close checklist + loose-as-buckets (no auto-writes)
  vision.ts             # chunked vision doc embedding, alignment scoring
  reviewer.ts           # multi-provider LLM review
  labels.ts             # GitHub label management with rate limiting
  write-gate.ts         # one dry-run-by-default gate every GitHub mutation funnels through (read-only ethos)
  benchmark.ts          # embedding provider benchmark tool
  config.ts             # Zod-validated YAML + env config
  errors.ts             # typed error classes
  types.ts              # shared interfaces
  index.ts              # public API barrel export
  __tests__/            # 23 test files (309 tests total incl. server)

server/                 # webhook server (GitHub App)
  index.ts              # Hono server entry point
  routing.ts            # webhook event routing
  webhook.ts            # PR/issue event handlers
  triage.ts             # automated triage pipeline
  scheduler.ts          # cron-based periodic re-scan
  auth.ts               # GitHub App JWT + installation token auth
  config.ts             # server-specific config
  db.ts                 # server database helpers
  format.ts             # output formatting
  __tests__/            # 8 test files
```

## key patterns

- **pipeline**: scan -> embed -> cluster -> score -> vision -> review. each step is independently testable
- **multi-provider**: embedding and LLM providers are factory-created via config. zero-cost default (ollama + opencode)
- **incremental processing**: only re-embeds new/changed items. crash-recoverable via sqlite
- **read-only default**: every GitHub mutation (labels, comments, closes, issue creation) funnels through one `write-gate.ts` gate that defaults to dry-run. CLI writes only under `--apply-labels`; the webhook server writes only when `PRISM_APPLY=1`. `--dry-run` always wins. (Fixes the prior leak where `ensureLabelsExist` created labels even under `--dry-run`, and the server writing unconditionally.)
- **cross-repo**: config accepts multiple repos, dupe detection works across repo boundaries
- **canonical selection**: one `selectCanonical()` (src/canonical.ts) picks each cluster's source of truth for the report, the starmap payload, and the live triage bot alike. issue-majority clusters resolve to the earliest report (the original bug); PR-majority ranks by lifecycle state (merged > open > closed), then a CI veto (a known-red build never outranks a same-state green sibling, before score), then quality score. the veto stops a high-scored PR with failing checks from becoming bestPick over the green fix that actually landed; only `ciStatus === "failure"` demotes, so a not-yet-reported PR is never penalized. fully deterministic - every tie bottoms out at item number - so re-runs name the same canonical
- **cluster confidence**: clustering is single-linkage (BFS over pairs >= threshold) with a centroid-refinement pass to break chained mega-clusters. because single-linkage can still chain in loosely-related members, each cluster reports both `avgSimilarity` and `minSimilarity` (lowest pairwise). the report/dupes output surfaces min as a confidence tier (high >= 90%, solid >= 80%, loose < 80%) so a low-min "loose" cluster gets eyeballed before anything is closed. avg and min are computed exactly over all pairs (no sampling), so the tier a maintainer sees is reproducible run to run

## database

single SQLite database per project, managed by `store.ts`.

| table | purpose |
|-------|---------|
| items | PRs and issues with metadata |
| embeddings | vector embeddings (sqlite-vec) |
| prism_meta | config versioning, model mismatch detection |

## commands

```bash
npm run dev          # run CLI via tsx
npm run build        # clean dist/ + tsc via tsconfig.build.json (excludes __tests__)
npm run typecheck    # tsc --noEmit on src (incl. tests) + server
npm test             # vitest run
npm run lint         # biome check
npm run ci           # build + lint + typecheck + test + CLI smoke
npm run server       # start webhook server
```

## release

- tag push `v*` triggers `.github/workflows/release.yml`: verify tag == package version → `npm ci` → `npm run ci` → `npm publish --provenance` → GitHub Release with generated notes
- npm auth: `NPM_TOKEN` repo secret (granular token scoped to prism-triage). **expires ~2026-10-07. rotate before then or publishes fail on auth**
- workflow is tag-push only (not fork-reachable); all actions pinned to commit SHAs
- the npm package excludes compiled tests (`tsconfig.build.json`); `npm run build` cleans `dist/` first so stale artifacts can't leak into a publish (the 2.0.1 orphan-file gotcha)
- brew tap bump is manual: update `Formula/prism-triage.rb` (tarball url + sha256) in StressTestor/homebrew-tap after the GitHub Release exists

last updated: 2026-07-13
