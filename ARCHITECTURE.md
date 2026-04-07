# architecture

## overview

pr-prism is a triage tool for repos drowning in PRs. CLI scans GitHub, embeds items locally, clusters duplicates, ranks by quality signals, checks vision alignment, and runs LLM reviews. optional webhook server for automated triage on new PRs.

## stack

| layer | technology | version |
|-------|-----------|---------|
| language | TypeScript | 5.x |
| runtime | Node.js | 22+ |
| CLI framework | Commander.js | 13.x |
| database | better-sqlite3 + sqlite-vec | 11.x / 0.1.x |
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
  pipeline.ts           # orchestrates scan -> embed -> cluster -> score -> vision -> review
  github.ts             # GraphQL + REST client, rate limiting, backoff
  embeddings.ts         # 5 embedding providers, batch processing, dimension detection
  store.ts              # SQLite + sqlite-vec, schema migrations, dimension validation
  cluster.ts            # cosine similarity, BFS clustering, duplicate detection
  similarity.ts         # ANN pre-filtering, matryoshka truncation
  scorer.ts             # 7 quality signals: tests, CI, diff size, author history, etc.
  vision.ts             # chunked vision doc embedding, alignment scoring
  reviewer.ts           # multi-provider LLM review
  labels.ts             # GitHub label management with rate limiting
  benchmark.ts          # embedding provider benchmark tool
  config.ts             # Zod-validated YAML + env config
  errors.ts             # typed error classes
  types.ts              # shared interfaces
  index.ts              # public API barrel export
  __tests__/            # 15 test files, 199 tests

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
  __tests__/            # 7 test files
```

## key patterns

- **pipeline**: scan -> embed -> cluster -> score -> vision -> review. each step is independently testable
- **multi-provider**: embedding and LLM providers are factory-created via config. zero-cost default (ollama + opencode)
- **incremental processing**: only re-embeds new/changed items. crash-recoverable via sqlite
- **read-only default**: no repo modifications unless `--apply-labels` explicitly passed
- **cross-repo**: config accepts multiple repos, dupe detection works across repo boundaries

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
npm run build        # tsc compile
npm test             # vitest run
npm run lint         # biome check
npm run ci           # lint + typecheck + test
npm run server       # start webhook server
```

last updated: 2026-04-07
