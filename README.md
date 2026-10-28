# pr-prism

[![CI](https://github.com/StressTestor/pr-prism/actions/workflows/ci.yml/badge.svg)](https://github.com/StressTestor/pr-prism/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/prism-triage)](https://www.npmjs.com/package/prism-triage)
[![license](https://img.shields.io/github/license/StressTestor/pr-prism)](LICENSE)
[![node](https://img.shields.io/node/v/prism-triage)](package.json)

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
prism dupes --starmap map.json      # stable JSON contract for visualizers
prism dupes --housekeeping todo.md  # editable close-checklist manifest
prism init -r owner/repo -y         # non-interactive init, repo from flag
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
prism benchmark --provider openai --base-url https://compatible-provider.example/v1 \
  --dimensions 1024 --models provider/model-a,provider/model-b
```

`prism benchmark` defaults to Ollama and retains automatic local model checks/pulls. Custom providers use the generic
embedding configuration below; credentials always come from `EMBEDDING_API_KEY`. Never supply API keys as command-line
arguments. The benchmark refetches the current repository population once and compares cluster overlap and speed across
models; it is not a labelled accuracy benchmark.

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
| decision | jev (TypeSafe AI) | paid (opt-in) | System One model (`jev-1.14.0`) for typed decisions, disabled by default |
| decision | mock | free | deterministic offline testing provider |

## typed decisions (phase 1)

pr-prism includes an optional, model-agnostic **Typed Decision Layer** powered by TypeSafe AI's Jev (`jev-1.14.0`). It computes structured categorical selections and calibrated probabilities (`Choice`, `Score`, `Noul`) to help classify items and recommend advisory triage paths.

### key principles

- **disabled by default**: pr-prism starts with zero network calls to paid inference APIs. Existing scans, duplicate clustering, ranking, and reviews are completely unchanged. The presence of `TYPESAFE_API_KEY` does **not** activate Jev; typed decisions remain disabled unless `decisions.enabled: true` in `prism.config.yaml` or `DECISION_ENABLED=true` in `.env` is explicitly configured. Normal startup makes zero TypeSafe requests.
- **four orthogonal dimensions**:
  1. *PR Quality*: deterministic signals from `scorer.ts` (CI status, test coverage, diff size).
  2. *Product Relevance*: semantic alignment from `vision.ts` (`VISION.md` embedding similarity).
  3. *Evidence Quality*: rubric scores assessing reproduction steps and description completeness.
  4. *Technical Severity & Risk*: rubric scores and calibrated risk nouls (security risk, breaking change).
- **strictly advisory**: model probabilities never authorize PR closure, approval, or rejection. Low reproduction evidence routes to `needs_reproduction` or `maintainer_triage`, never automated closure. Missing or unevaluated risk assessments are explicitly represented as `null` rather than assumed zero, and unknown security risks trigger safe escalation.
- **trusted metadata first**: deterministic fields already established by GitHub (such as `pr` vs `issue` type and bot status) are authoritative and consumed directly from GitHub metadata; model responses can never override `PRItem.type`.
- **untrusted input defense & bounded limits**: contributor text is strictly sanitized and length-bounded before model evaluation:
  - Titles: bounded to 500 characters in decision context (display tables cap at 256 characters).
  - Bodies: bounded to 16,000 characters (~4k tokens) with clean `[...truncated for decision context]` marker.
  - Metadata: repo (200 chars), author (100 chars), state (50 chars), labels (100 chars each).
  - Secrets: credentials and API keys matching common patterns are redacted to `[REDACTED_SECRET]`.
  - ANSI escapes and non-printable control characters are stripped; Unicode normalized (NFC).
  - Provenance: SHA-256 fingerprinting of input state, question rubrics, and model versions ensures tamper-evident audit trails.
- **repository generality**: uses a universal generic domain taxonomy (`core_logic`, `api_service`, `ui_ux`, `data_storage`, `integrations`, `ci_infra`, `documentation`, `other`) suitable for arbitrary GitHub repositories, with configurable domain taxonomy overrides.

### configuration

In `prism.config.yaml`:
```yaml
decisions:
  enabled: true
  provider: jev
  model: jev-1.14.0
  timeout_ms: 10000
```

In `.env`:
```bash
TYPESAFE_API_KEY=your_typesafe_api_key_here
```

### programmatic usage (with mock inference)

```typescript
import { createDecisionProvider, evaluateItemDecisions } from "prism-triage";

// Deterministic offline evaluation without network calls
const provider = createDecisionProvider({ provider: "mock" });

const report = await evaluateItemDecisions(
  {
    number: 42,
    type: "issue",
    repo: "owner/repo",
    title: "App crashes when vector store table is missing",
    body: "Steps to reproduce: 1. Delete data/prism.db 2. Run prism stats",
    author: "contributor",
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
    labels: ["bug"],
    state: "open",
  },
  provider,
);

console.log(report.classification); // { category: "bug", technicalDomain: "data_storage" }
console.log(report.item.type);      // "issue" (resolved from trusted metadata)
console.log(report.advisoryRoute);  // "maintainer_triage"
console.log(report.provenance);     // { provider: "mock", model: "mock-jev-1.14.0", inputHash: "...", rubricHash: "...", decisionIdentity: "..." }
```

OpenAI-compatible embedding and chat endpoints use the existing generic `openai` provider. Featherless.ai is one tested
compatible endpoint; it does not require a dedicated provider name or vendor-specific environment variables.

```dotenv
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=https://compatible-provider.example/v1
EMBEDDING_API_KEY=your_embedding_key
EMBEDDING_MODEL=provider/model
EMBEDDING_DIMENSIONS=1024

LLM_PROVIDER=openai
LLM_BASE_URL=https://compatible-provider.example/v1
LLM_API_KEY=your_llm_key
LLM_MODEL=provider/model
```

`EMBEDDING_BASE_URL` and `LLM_BASE_URL` are optional and default to `https://api.openai.com/v1`. Unknown compatible
embedding models must set `EMBEDDING_DIMENSIONS`; known OpenAI defaults are inferred for `text-embedding-3-small`,
`text-embedding-3-large`, and `text-embedding-ada-002`. The `text-embedding-3-*` models and unknown compatible models
can request provider-selected dimensions. `text-embedding-ada-002` is fixed at 1536 dimensions; explicitly setting 1536
validates that size but does not send a dimensional-selection request. Embedding and LLM API keys remain separate.

Provider-selected reduced vectors and locally truncated vectors are distinct embedding spaces. If an existing database
was created with local truncation, run `prism re-embed` (or `prism reset`) before scanning with provider-selected
dimensions.

## labeling

prism can label your github PRs/issues but won't unless you say so:

```bash
prism dupes --apply-labels      # mark dupes + best picks
prism vision --apply-labels     # aligned/drifting/off-vision
prism dupes --dry-run           # preview first
```

read-only by default. always.

every github write (labels, comments, closes, issue creation) funnels through one
gate that defaults to dry-run. the CLI writes only under `--apply-labels`. the
webhook server writes only when `PRISM_APPLY=1` is set - without it a deployed bot
logs what it *would* do instead of touching the repo. `--dry-run` always wins.

## housekeeping

`prism dupes --housekeeping todo.md` writes an editable markdown checklist: per
cluster, the tracker issue (the original bug report), role-tagged fix/duplicate
candidates, and paste-ready close text. loose clusters get flagged for review
instead of a close directive. confirmed exact-dupes lead the checklist.

it's a checklist you edit and act on. prism never closes anything itself.

## star map export

`prism dupes --starmap map.json` emits a stable JSON contract for external
visualizers (schema v1, additive-only evolution): clusters with confidence tiers,
contested + runner-up, tracker, item state (open/closed/merged), embedding
metadata, and github node ids as a join key.

clusters also carry a deterministic `relation` label built from github's closing
edges: `pr-issue-linked` (a member PR closes a member issue, resolved pairs in
`closingEdges`), `pr-issue-unlinked`, `prs-only`, or `issues-only`. PR items list
their same-repo closing refs in `closes`. `relation` is omitted when a member PR
was scanned before this field existed, so stale rows read as unknown instead of
getting a wrong label. re-scan once to populate it: unchanged items pick up
closing refs (and current ciStatus/reviewCount/labels) without re-embedding.
closing refs come from the GraphQL scan; `--use-rest` scans leave them unknown,
like the other deep-scan signals.

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
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: StressTestor/pr-prism@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          embedding-provider: jina
          embedding-api-key: ${{ secrets.JINA_API_KEY }}
```

> **Node.js runtime requirement**: pr-prism requires Node.js >= 22.0.0 (Node 22 or 24 LTS recommended). Workflows invoking the composite GitHub Action must include `actions/setup-node@v4` with `node-version: 22` to ensure a compatible runtime.

on pull_request events, prism checks if the new PR is a duplicate and comments with matches. on schedule, it does a full triage scan.

## docker

```bash
docker build -t pr-prism .
docker run --rm -v $(pwd):/work -w /work --env-file .env pr-prism triage
```

## live triage bot

run pr-prism as a GitHub App that auto-triages every new issue and PR in real time.

**what it does:**
- comments on new issues with duplicate matches and source-of-truth links
- optionally auto-closes obvious dupes (>95% similarity, opt-in)
- suggests code owners via CODEOWNERS parsing
- posts a weekly triage digest
- runs a full backlog scan when first installed on a repo

**self-hosted setup:**
1. register a GitHub App at github.com/settings/apps/new
   - permissions: issues (read+write), pull requests (read), metadata (read), contents (read)
   - webhook URL: your server's public URL + /webhook
   - subscribe to events: issues, pull_request, installation, installation_repositories
2. provision a server (Oracle ARM free tier works)
3. run the setup script:
   ```bash
   git clone https://github.com/StressTestor/pr-prism.git /opt/prism-bot
   cd /opt/prism-bot && ./server/deploy/setup.sh
   ```
4. copy your .env and private key, then restart the service

**per-repo config:** drop a `.prism.json` in your repo root to customize:
```json
{
  "autoClose": true,
  "autoCloseThreshold": 0.95,
  "similarityThreshold": 0.85,
  "weeklyDigest": true,
  "smartRouting": true
}
```

## how dupe detection works

embeds every PR/issue title+body into a vector, stores in sqlite-vec, computes cosine similarity across all pairs. anything above 0.85 gets clustered. each cluster picks a "best" based on quality score (tests, CI, diff size, reviews, recency, description quality). rest get flagged as dupes.

every cluster reports a confidence tier off its minimum pairwise similarity (high >= 90%, solid >= 80%, loose < 80%), so a chained-together loose cluster gets eyeballed before anything is closed. near-tied best picks get a contested flag with the runner-up named. issue-majority clusters resolve to the earliest report (the original bug), PR-majority to the highest quality item, and merged PRs beat open ones.

above the embedding clusters sits a confirmed tier: PRs with the same head commit or an identical patch (git patch-id) are exact duplicates, grouped deterministically with no similarity threshold involved.

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

- dimensional selection: OpenAI-compatible endpoints receive `EMBEDDING_DIMENSIONS` in the request; other providers use
  local Matryoshka truncation when supported
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

### V5 review operations

Build locally with Node 22 or newer: `npm ci && npm run build`; invoke `node dist/cli.js` (or install the local package in an isolated project). Native backlog operations require an explicit repository and a separate V5 data directory:

```sh
export PRISM_DATA_DIR=./review-data
# GITHUB_TOKEN supplies read-only repository access.
node dist/cli.js review --all-open --repo example/project --type pr --dry-run --json
node dist/cli.js review --all-open --repo example/project --type pr --max-new-calls 60 --run-id batch-1
node dist/cli.js review --dashboard --repo example/project --type pr --refresh 5
node dist/cli.js review --operations --status --repo example/project --type issue --json
```

Configure `PRISM_REVIEW_ACCOUNTS` as a JSON array, for example
`[{"id":"account-a","model":"your-model","endpoint":"https://provider.example/v1/chat/completions","keyEnv":"REVIEW_API_KEY"}]`,
and supply the corresponding credential through that environment variable. Up to three distinct account IDs share durable attempt accounting. A failed or interrupted outbound attempt consumes budget. Resume with the same `--run-id`, budget and `--resume`; a new run ID authorizes a new bounded budget. Dry-run, status and dashboard dispatch no paid calls. Dry-run does persist its read-only GitHub inventory locally.

Use `--type issue` for the issue evidence contract. Saved findings are unverified recommendations requiring independent source/test confirmation. Operations never post or merge. Complete PR coverage requires verified pinned sources and a complete changed-file manifest. Binary/unavailable evidence is reported as partial. Use `review --recover --repo example/project --type pr` to recover expired local work without inference; uncertain requests remain charged and require explicit `--acknowledge-uncertain ATTEMPT_ID` before retry planning. See the recorded integration verdict in the acceptance report; see [design](V5_REVIEW_OPERATIONS_DESIGN.md), [acceptance](V5_REVIEW_OPERATIONS_ACCEPTANCE.md) and [offline import plan](V5_REVIEW_OPERATIONS_IMPORT_PLAN.md).


V5 hardening uses metadata-only inventory for backlog discovery. `inventoryKnown` counts items whose
conversation/source evidence has not been inspected; these cannot count as completed reviews.
Full evidence is hydrated only for selected reviews, then revalidated before each reserved request
and final completion. Periodic probes apply to previously hydrated items and detect comment deletion,
linked-fix changes and external actions. Unchanged metadata alone does not verify a conversation.
Probes rotate over at most 100 hydrated items per invocation; large hydrated backlogs need multiple
invocations for a complete verification cycle. A 403/429 records a persistent reset/Retry-After cooldown and leaves the reliable cursor unchanged;
retry the command after that time. Permission failures also fail closed and may require token repair.

V4 queue inspection remains `prism review --queue-db PATH --status --json`. V5 inspection requires
`prism review --operations --status --repo OWNER/REPO --type pr --json` (or `--operations-db PATH`).
Bare `review --status` reports a selector error without loading credentials. Modes cannot be mixed.
Issue classification through `scan`/`dupes` remains embedding-first; deep issue reviews are optional
and require explicit review execution. V5 does not import or reuse the external Python PR reviews.

The package now consistently declares Node >=22, matching `@typesafe-ai/sdk@0.7.0`'s engine contract
and the existing V4 runtime documentation. This is a deliberate compatibility change from upstream's
Node >=20 contract, to be highlighted in the upstream PR. Passing diagnostic Node 20 tests does not
establish supported SDK operation on Node 20. Package name/version remain `prism-triage@4.0.0`;
this branch is a review candidate, not a published release.
