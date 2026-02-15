# pr-prism

triage tool for repos drowning in PRs. finds dupes, ranks quality, checks if PRs actually align with where your project is headed.

built this because i was staring at 3000+ open PRs on a repo and losing my mind trying to figure out which ones were duplicates of each other. turns out like 40% of them were.

## what it does

- **scan** — pulls open PRs + issues into a local sqlite db
- **dupes** — embeds everything, clusters by cosine similarity, finds which PRs are basically the same
- **rank** — scores PRs on a bunch of signals (tests, CI, diff size, author history, description quality, approvals)
- **vision** — compares each PR against your VISION.md or README to see if its actually going in the right direction
- **review** — LLM review of a single PR, gives you a merge/revise/close recommendation
- **triage** — runs everything in one shot
- **report** — dumps a markdown report with all the findings

## setup

```bash
git clone https://github.com/StressTestor/pr-prism.git
cd pr-prism
npm install && npm run build
cp .env.example .env
# fill in your api keys in .env
```

edit `prism.config.yaml`:

```yaml
repo: your-org/your-repo
```

then just:

```bash
npx prism triage
```

or run the commands individually if you want more control. `npx prism scan`, `npx prism dupes`, etc.

## zero cost setup

you can run the whole thing for free:

- **embeddings**: [jina](https://jina.ai/embeddings/) — 10M free tokens per api key, no account needed
- **LLM**: [opencode zen](https://opencode.ai/zen) — kimi-k2.5-free, literally $0
- **github**: 5000 req/hr with a PAT

`.env.example` is already set up for this. just grab the keys and go.

## providers

embeddings: jina (free, default), openai, voyageai, kimi, ollama (local)

LLM: opencode (free kimi, default), openai, anthropic, kimi, ollama (local)

check `.env.example` for the env var names.

## config

all in `prism.config.yaml`. defaults are sane, you really only need to set `repo`:

```yaml
repo: owner/repo
vision_doc: ./VISION.md  # optional, falls back to repo README

thresholds:
  duplicate_similarity: 0.85
  aligned: 0.65
  drifting: 0.40
  off_vision: 0.40

scoring:
  weights:
    has_tests: 0.25
    ci_passing: 0.20
    diff_size_penalty: 0.15
    author_history: 0.15
    description_quality: 0.15
    review_approvals: 0.10
```

## labeling

prism can slap labels on your github PRs/issues but it wont unless you tell it to:

```bash
npx prism dupes --apply-labels      # mark dupes + best picks
npx prism vision --apply-labels     # aligned/drifting/off-vision
npx prism dupes --dry-run           # preview first
```

read-only by default. always.

## how the dupe detection works

embeds every PR/issue title+body into a vector, stores them in sqlite-vec, computes cosine similarity across all pairs. anything above 0.85 gets clustered together, each cluster picks a "best" based on quality score, rest get flagged as dupes.

tested on a repo with ~6000 open items — found 594 clusters covering 2500+ items.

## vision alignment

splits your VISION.md (or README) by headings, embeds each section, compares PR embeddings against them. highest similarity = alignment score. no vision doc? pulls the README automatically.

## project structure

```
src/
  cli.ts          — CLI + pipeline orchestration
  config.ts       — yaml + env config, zod validation
  github.ts       — octokit wrapper, rate limiting
  embeddings.ts   — multi-provider embedding
  store.ts        — sqlite + sqlite-vec
  cluster.ts      — duplicate clustering
  scorer.ts       — quality scoring
  vision.ts       — vision alignment
  reviewer.ts     — LLM PR review
  labels.ts       — github label management
  types.ts        — shared types
```

single sqlite db under `data/`. embeddings stored as vectors via sqlite-vec. diffs get cached.

## notes

- first scan+embed of ~6k items takes 30-40 min on jina free tier (rate limited to 100k tokens/min)
- after that its incremental, only embeds new/changed items
- clustering is fast, bottleneck is always the embedding api on first run

## license

MIT
