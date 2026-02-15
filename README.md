# pr-prism

triage tool for repos drowning in PRs. finds duplicates, ranks quality, checks alignment against your project vision. runs entirely local except for the API calls you configure.

built because maintaining an open source project with thousands of open PRs is actual hell and nobody should have to read 3000 titles to figure out which 40 are duplicates of each other.

## what it does

- **scan** — pulls every open PR and issue from a repo into a local sqlite database
- **dupes** — embeds everything, clusters by cosine similarity, tells you which PRs are saying the same thing
- **rank** — scores PRs by quality signals (description quality, diff size, author track record, CI status, review approvals)
- **vision** — checks each PR against your VISION.md or README.md to see if it's aligned with where the project is going
- **review** — deep LLM review of a single PR (summary, concerns, merge/revise/close recommendation)
- **triage** — runs the whole pipeline in one shot

## quickstart

```bash
git clone https://github.com/StressTestor/pr-prism.git
cd pr-prism
npm install
npm run build
```

copy the example env and fill in your keys:

```bash
cp .env.example .env
```

edit `prism.config.yaml` to point at your repo:

```yaml
repo: your-org/your-repo
vision_doc: ./VISION.md  # optional, falls back to repo README
```

run it:

```bash
# full pipeline
npx prism triage

# or step by step
npx prism scan
npx prism dupes
npx prism rank
npx prism vision
npx prism review 1234
```

## zero cost setup

you can run this without spending a dime:

| what | provider | cost |
|------|----------|------|
| embeddings | [jina](https://jina.ai/embeddings/) | 10M tokens free per API key |
| LLM | [opencode zen](https://opencode.ai/zen) | kimi-k2.5-free, $0 |
| github API | github | 5000 requests/hr with a PAT |

the `.env.example` is already configured for this setup. just grab the keys.

## providers

### embeddings

| provider | env value | notes |
|----------|-----------|-------|
| jina | `jina` | 10M free tokens, 1024 dimensions, no account needed |
| openai | `openai` | text-embedding-3-small/large |
| voyage | `voyageai` | voyage-2 |
| moonshot | `kimi` | kimi embeddings |
| ollama | `ollama` | local, zero cost, any model |

### LLM (for review + scoring)

| provider | env value | notes |
|----------|-----------|-------|
| opencode zen | `opencode` | kimi-k2.5-free at zero cost |
| openai | `openai` | gpt-4o-mini, etc |
| anthropic | `anthropic` | claude models |
| moonshot | `kimi` | kimi models |
| ollama | `ollama` | local models |

## config

`prism.config.yaml`:

```yaml
repo: owner/repo
vision_doc: ./VISION.md  # optional

thresholds:
  duplicate_similarity: 0.85  # how similar before it's a dupe
  aligned: 0.65               # vision alignment score
  drifting: 0.40              # below this = drifting
  off_vision: 0.40            # below drifting = off-vision

scoring:
  weights:
    has_tests: 0.25
    ci_passing: 0.20
    diff_size_penalty: 0.15
    author_history: 0.15
    description_quality: 0.15
    review_approvals: 0.10

labels:
  duplicate: "prism:duplicate"
  aligned: "prism:aligned"
  drifting: "prism:drifting"
  off_vision: "prism:off-vision"
  top_pick: "prism:top-pick"

batch_size: 50
max_prs: 5000
```

## labeling

prism can apply labels directly to github PRs/issues:

```bash
npx prism dupes --apply-labels      # mark duplicates + best picks
npx prism vision --apply-labels     # mark aligned/drifting/off-vision
npx prism dupes --dry-run           # preview without touching anything
```

labels are never applied unless you explicitly ask for it. read-only by default.

## how duplicate detection works

1. every PR/issue title + body gets embedded into a 1024-dim vector
2. all vectors get stored in sqlite-vec (sqlite with vector search)
3. cosine similarity is computed across all pairs
4. items above the threshold (default 0.85) get clustered together
5. each cluster picks a "best" item based on quality score
6. the rest get flagged as duplicates

on a repo with ~6000 open PRs/issues, this found 594 duplicate clusters covering 2500+ items. 40% of all open items were duplicates.

## how vision alignment works

1. your VISION.md (or README.md) gets split by headings and embedded
2. each PR's embedding is compared against every vision section
3. highest cosine similarity determines the alignment score
4. PRs get classified as aligned, drifting, or off-vision

no VISION.md? prism will pull the repo's README.md automatically and use that.

## architecture

```
src/
  cli.ts          — commander CLI, pipeline orchestration
  config.ts       — yaml + env config loading with zod validation
  github.ts       — octokit wrapper with rate limiting + backoff
  embeddings.ts   — multi-provider embedding (jina, openai, voyage, kimi, ollama)
  store.ts        — sqlite + sqlite-vec storage layer
  cluster.ts      — duplicate clustering via cosine similarity
  scorer.ts       — weighted quality scoring
  vision.ts       — vision document alignment checking
  reviewer.ts     — LLM-powered deep PR review
  labels.ts       — github label management
  types.ts        — shared interfaces
```

everything lives in a single sqlite database under `data/prism.db`. embeddings are stored as vectors via sqlite-vec. diffs get cached so you don't re-fetch them.

## performance notes

- initial scan + embed of ~6000 items takes about 30-40 min on jina free tier (100K tokens/min rate limit)
- subsequent runs only need to embed new items
- duplicate clustering is CPU-bound but fast (seconds for 6000 items)
- the bottleneck is always the embedding API rate limit on first run

## license

MIT
