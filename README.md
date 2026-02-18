# pr-prism

triage tool for repos drowning in PRs. finds dupes, ranks quality, checks if PRs actually align with where your project is headed.

built this because i saw someone was staring at 3000+ open PRs on a repo and losing their mind trying to figure out which ones were duplicates of each other. turns out like 40% of them were.

## what it does

- **scan** — pulls open PRs + issues via GitHub GraphQL API into a local sqlite db. gets CI status, review counts, test file detection, diff stats — all in one pass
- **dupes** — embeds everything, clusters by cosine similarity, finds which PRs are basically the same
- **rank** — scores PRs on a bunch of signals (tests, CI, diff size, author history, description quality, approvals)
- **vision** — compares each PR against your VISION.md or README to see if its actually going in the right direction
- **review** — LLM review of a single PR, gives you a merge/revise/close recommendation
- **triage** — runs everything in one shot
- **report** — dumps a markdown report with all the findings
- **re-embed** — re-embeds all items with your current provider without re-scanning github
- **reset** — wipe the database and start fresh

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

you can run the whole thing for free with zero external API calls for embeddings:

- **embeddings**: [ollama](https://ollama.com) + `qwen3-embedding:0.6b` — runs locally, no API key, no rate limits
- **LLM**: [opencode zen](https://opencode.ai/zen) — kimi-k2.5-free, literally $0
- **github**: 5000 GraphQL points/hr with a PAT (scanning 3500+ PRs uses ~36 queries)

```bash
# install ollama and pull the model
brew install ollama
ollama pull qwen3-embedding:0.6b
```

`.env.example` is already set up for this. just grab a github token and go.

if you prefer cloud embeddings, [jina](https://jina.ai/embeddings/) gives 10M free tokens per api key with no account needed.

## providers

embeddings: ollama (local, default), jina, openai, voyageai, kimi

LLM: opencode (free kimi, default), openai, anthropic, kimi, ollama (local)

check `.env.example` for the env var names.

## config

all in `prism.config.yaml`. defaults are sane, you really only need to set `repo`:

```yaml
version: 1
repo: owner/repo
vision_doc: ./VISION.md  # optional, falls back to repo README

thresholds:
  duplicate_similarity: 0.85
  aligned: 0.65
  drifting: 0.40

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

## scan modes

default scan uses GitHub's GraphQL API — pulls PRs with CI status, review counts, changed files, and test detection all in a single paginated query. a repo with 3500+ open PRs takes ~36 queries instead of ~14,000 REST calls.

```bash
npx prism scan                     # GraphQL (default)
npx prism scan --rest              # REST fallback for tokens without GraphQL scope
```

## how the dupe detection works

embeds every PR/issue title+body into a vector, stores them in sqlite-vec, computes cosine similarity across all pairs. anything above 0.85 gets clustered together, each cluster picks a "best" based on quality score, rest get flagged as dupes.

tested on a repo with ~7000 open items — found 210 clusters covering 680+ items.

## vision alignment

splits your VISION.md (or README) by headings, embeds each section, compares PR embeddings against them. highest similarity = alignment score. no vision doc? pulls the README automatically.

## project structure

```
src/
  cli.ts          — CLI + pipeline orchestration
  config.ts       — yaml + env config, zod validation
  github.ts       — GraphQL + REST client, rate limiting
  embeddings.ts   — multi-provider embedding (ollama, jina, openai, voyageai, kimi)
  store.ts        — sqlite + sqlite-vec with dimension validation
  cluster.ts      — duplicate clustering
  scorer.ts       — quality scoring (7 signals)
  vision.ts       — vision alignment
  reviewer.ts     — LLM PR review
  labels.ts       — github label management
  types.ts        — shared types
```

single sqlite db under `data/`. embeddings stored as vectors via sqlite-vec. diffs get cached.

## notes

- first scan of ~3500 PRs via GraphQL takes ~3 min (mostly pagination + author history lookups)
- embedding ~7000 items with ollama locally takes ~80 min on M1 Air (batch size auto-scales to 50 for local models)
- after that its incremental, only embeds new/changed items
- clustering is fast, bottleneck is always the embedding step on first run
- if you switch embedding providers, run `npx prism re-embed` to re-embed with the new model, or `npx prism reset` to start fresh

## license

MIT
