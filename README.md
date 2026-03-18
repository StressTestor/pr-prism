# pr-prism

[![CI](https://github.com/StressTestor/pr-prism/actions/workflows/ci.yml/badge.svg)](https://github.com/StressTestor/pr-prism/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/prism-triage)](https://www.npmjs.com/package/prism-triage)
[![license](https://img.shields.io/github/license/StressTestor/pr-prism)](LICENSE)
[![node](https://img.shields.io/node/v/pr-prism)](package.json)

triage tool for repos drowning in PRs. finds dupes, ranks quality, checks vision alignment across repos.

built this because i saw someone staring at 3000+ open PRs and losing their mind trying to figure out which ones were duplicates. turns out 40% of them were. ran pr-prism on 6K+ items across a real repo, found 594 duplicate clusters.

who this is for: maintainers, triage teams, anyone staring at a 4-digit PR count and wondering where to start.

## quickstart

```bash
brew tap stresstestor/tap && brew install prism-triage
prism init
prism scan
prism triage
```

or with npm: `npm install -g prism-triage`

## pipeline

```
scan ─── fetch PRs + issues via GraphQL
  │
embed ── vectorize titles + bodies
  │
  ├── dupes ── cluster by cosine similarity
  ├── rank ─── score by quality signals
  ├── vision ─ check alignment with VISION.md
  └── review ─ LLM deep review
  │
triage ─ run everything in one shot
```

## why pr-prism

- **zero cost default**: ollama + opencode zen + github PAT. $0 to run
- **local-first**: sqlite + sqlite-vec, everything stays on your machine
- **multi-repo**: `repos: [a/b, c/d]` in config, cross-repo dupe detection
- **multi-provider**: ollama, jina, openai, voyage, kimi for embeddings. opencode, openai, anthropic, kimi, ollama for LLM
- **cross-repo dupes**: the thing no other free tool does. finds duplicates across different repos
- **incremental**: only re-embeds new/changed items, crash-recoverable
- **read-only by default**: won't touch your repo unless you pass `--apply-labels`

## commands

| command | what it does |
|---------|-------------|
| `prism scan` | fetch PRs + issues into local db (GraphQL default, `--rest` fallback) |
| `prism dupes` | cluster duplicates, show best picks |
| `prism rank` | score and rank by quality signals |
| `prism vision` | check alignment against VISION.md or README |
| `prism review <n>` | LLM review of a specific PR or issue |
| `prism triage` | full pipeline in one shot |
| `prism report` | generate markdown triage report |
| `prism stats` | database stats, embedding coverage, provider info |
| `prism doctor` | check config, providers, db health |
| `prism init` | auto-detect providers, generate config |
| `prism re-embed` | re-embed with current provider (no github fetch) |
| `prism compare <n1> <n2>` | compare two PRs/issues for similarity |
| `prism benchmark` | compare embedding models for quality + speed |
| `prism reset` | wipe database and start fresh |

## flags

```bash
prism scan --state all              # open + closed items
prism scan --since 7d               # only items updated in last 7 days
prism dupes --threshold 0.9         # stricter similarity
prism dupes --cluster 3             # inspect specific cluster
prism rank --top 50 --explain       # top 50 with signal breakdown
prism vision --stats                # histogram + section breakdown
prism vision --detail               # per-item alignment table
prism review --top 10               # batch review top 10
prism review 42 --type issue        # review an issue
prism review --show 42              # show saved review
prism triage --output markdown      # markdown output for github issues
prism dupes --json | jq '.bestPick' # machine-readable NDJSON
prism compare 42 99          # check similarity between two items
prism benchmark --repo sst/opencode                              # compare default models
prism benchmark --models nomic-embed-text,qwen3-embedding:0.6b    # specify models
```

## zero cost setup

run the whole thing for free:

- **embeddings**: [ollama](https://ollama.com) + `nomic-embed-text` (local, 768 dims, 3.7x faster than qwen3)
- **LLM**: [opencode zen](https://opencode.ai/zen) (kimi-k2.5-free, $0)
- **github**: 5000 GraphQL points/hr with a PAT (~36 queries for 3500+ PRs)

```bash
brew install ollama
ollama pull nomic-embed-text
```

cloud alternative: [jina](https://jina.ai/embeddings/) gives 10M free tokens per key, no account needed.

## multi-repo config

```yaml
version: 1

# single repo
repo: owner/repo

# or multi-repo
repos:
  - owner/repo1
  - owner/repo2
  - owner/repo3

# per-repo vision docs
vision_docs:
  owner/repo1: ./VISION_1.md
  owner/repo2: ./VISION_2.md
```

cross-repo dupe display: `[owner/repo1] #1234 <-> [owner/repo2] #567`

## providers

| type | provider | cost | notes |
|------|----------|------|-------|
| embedding | ollama | free | local, default (nomic-embed-text) |
| embedding | jina | free tier | 10M tokens/key |
| embedding | openai | paid | text-embedding-3-small |
| embedding | voyageai | paid | |
| embedding | kimi | free tier | |
| LLM | opencode | free | kimi-k2.5-free, default |
| LLM | openai | paid | gpt-4o-mini |
| LLM | anthropic | paid | |
| LLM | kimi | free tier | |
| LLM | ollama | free | local |

## labeling

prism can label your github PRs/issues but won't unless you say so:

```bash
prism dupes --apply-labels      # mark dupes + best picks
prism vision --apply-labels     # aligned/drifting/off-vision
prism dupes --dry-run           # preview first
```

read-only by default. always.

## github action

run pr-prism automatically on every PR:

```yaml
# .github/workflows/prism-triage.yml
name: PR Triage
on:
  pull_request:
    types: [opened, reopened]
  schedule:
    - cron: '0 0 * * 1'  # weekly full scan

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: StressTestor/pr-prism@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          embedding-provider: jina
          embedding-api-key: ${{ secrets.JINA_API_KEY }}
```

on pull_request events, prism checks if the new PR is a duplicate and comments with matches. on schedule, it does a full triage scan.

## docker

```bash
docker build -t pr-prism .
docker run --rm -v $(pwd):/work -w /work --env-file .env pr-prism triage
```

## how dupe detection works

embeds every PR/issue title+body into a vector, stores in sqlite-vec, computes cosine similarity across all pairs. anything above 0.85 gets clustered. each cluster picks a "best" based on quality score (tests, CI, diff size, reviews, recency, description quality). rest get flagged as dupes.

for repos with 5000+ items, automatically switches from brute-force to ANN pre-filtering via sqlite-vec, then verifies with exact cosine similarity.

## programmatic usage

pipeline functions are independently importable:

```ts
import { createPipelineContext, runScan, runDupes, runRank } from "prism-triage";

const ctx = await createPipelineContext();
await runScan(ctx, { json: true });
const clusters = await runDupes(ctx, { json: true });
ctx.store.close();
```

## performance

- matryoshka truncation: `EMBEDDING_DIMENSIONS=512` in .env halves storage with 91% clustering agreement
- ANN pre-filtering kicks in at 5000+ items automatically
- incremental scan: only embeds new/changed items
- crash recovery: resumes from last embedded item
- batch size: configurable via `batch_size` in config (default 50)

## notes

- first scan of ~3500 PRs via GraphQL: ~3 min (pagination + author history)
- embedding ~10000 items with nomic-embed-text locally: ~13 min on M1 Air (was ~47 min with qwen3)
- after that it's incremental
- switching providers: `prism re-embed` or `prism reset`
- sqlite-vec pinned at 0.1.7-alpha.2 (alpha but stable in our testing)

## contributing

see [CONTRIBUTING.md](CONTRIBUTING.md)

## license

MIT
