# PR Prism — Roadmap to v1.0 (v3 — final)

**Lens:** OSS adoption (real users, real stars, real traction)
**Current state:** v0.8 shipped (functionally complete core, repo packaging is pre-launch quality)
**Target:** v1.0 public release with adoption-ready packaging
**Node target:** >= 20 LTS
**Last updated:** 2026-03-04

---

## Current State Assessment

### What exists (v0.8)

- Full pipeline: scan → embed → dupes → rank → vision → review → triage
- GraphQL-based GitHub ingestion (~36 queries vs 14K+ REST calls)
- Local embedding via Ollama (qwen3-embedding:0.6b) + remote providers (Jina, OpenAI, Voyage, Kimi)
- sqlite + sqlite-vec storage with ANN pre-filtering → exact cosine verification
- Multi-provider LLM support for review (OpenCode Zen, OpenAI, Anthropic, Kimi, Ollama)
- Zero-cost default stack (Jina free tier + OpenCode Zen + GitHub PAT)
- Zod-validated YAML config
- CLI extracted as thin wrapper over programmatic API (v0.7 refactor)
- 78 tests
- `--json` flag on all commands for machine-readable output
- DB schema already multi-repo capable (`items.repo TEXT NOT NULL`, `idx_items_repo` index, `diffs.repo` in composite PK)
- VectorStore.init() already validates stored model matches current model
- Proven on OpenClaw: 6K+ items, 594 dupe clusters, 40% duplicate rate, 75/3600/3569 vision split

### Adoption blockers

- 0 releases, 0 tags — no versioning signal
- 4 commits — squashed history hides engineering depth
- No CI — no build badge, no trust signal
- Not on npm — requires `git clone`, `npx pr-prism` doesn't work
- `engines: >= 21.2.0` — locks out anyone on LTS (most professional environments)
- No visuals — no GIF, no mermaid diagram, no terminal screenshots
- No CHANGELOG — version history invisible
- No contributing guide — signals "don't touch"
- Error UX inconsistent across providers
- No progress persistence — crashing mid-embed means starting over
- sqlite-vec pinned at 0.1.7-alpha.2 — document the risk, pin the version, don't block launch on it

---

## Milestone Structure

Three milestones. Each has a theme, a gate question, a definition of done, and an effort estimate.

---

## v0.9 — Credibility & Packaging

**Theme:** Make the repo installable, trustworthy, and pleasant to use before anyone sees it.
**Gate:** "Would I clone this?"
**Effort:** 2–3 focused sessions

### 0.9.1 — Repository Infrastructure

**npm publish readiness**
- Package name: `pr-prism` (verify npm availability)
- `bin` field in package.json → compiled CLI entry point
- `files` array or `.npmignore` — exclude `data/`, test fixtures, dev configs
- `engines` field: `>= 20.0.0`
- Verify `npx pr-prism triage` works from a clean install
- `prepublishOnly` script: build + test

**Node 20 LTS compatibility audit**
- Audit codebase for Node 21+ APIs (import.meta.resolve stability, any APIs that landed post-20)
- Replace or polyfill anything that breaks on Node 20
- This is an explicit work item, not just a CI matrix change
- Test: clean install on Node 20.x, run full pipeline

**GitHub Actions CI pipeline**
- Trigger on push to main + PRs
- Steps: install → build → lint → test → smoke test
- Smoke test: run `prism --version` + `prism --help` + `prism doctor` against a fixture DB (catches native binding / import resolution issues that unit tests miss)
- Matrix: Node 20.x + 22.x (current LTS + current stable)
- Badge in README

**Semantic versioning + releases**
- Tag current main as v0.8.0 retroactively
- CHANGELOG.md covering v0.1–v0.8 (reconstruct from build log — version themes are clean: GraphQL, local embeddings, productionization, reliability, API pivot, scale)
- First GitHub Release with auto-generated notes
- Commit granularly from v0.9 forward — commit history is the portfolio

**Contributing guide (CONTRIBUTING.md)**
- Dev setup: clone, install, build, test
- How to add a new embedding/LLM provider (most likely contribution vector)
- Issue/PR conventions
- Keep it under 100 lines

### 0.9.2 — Error UX & Resilience

**Unified error handling across all providers**

Every provider error must answer three questions: what failed, why, what to do about it.

| Provider | Error | Message |
|----------|-------|---------|
| Ollama | ECONNREFUSED | "Ollama isn't running. Start it with `ollama serve`" |
| Ollama | Model not found | "Model {model} not found. Pull it with `ollama pull {model}`" |
| Jina | 429 | "Rate limited. Waiting {n}s before retry ({attempt}/{max})" |
| OpenAI | 401 | "Invalid API key. Check OPENAI_API_KEY in your .env" |
| GitHub | 403 | "Token lacks required scopes. Needs `repo` for private repos, `public_repo` for public" |
| GitHub | 401 | "GitHub token invalid or expired. Generate a new PAT at https://github.com/settings/tokens" |
| Any | Network | "Cannot reach {provider}. Check your internet connection" |
| Any | Unknown | "Provider {name} returned {status}: {message}. Check your .env configuration" |

**Progress persistence for embedding**
- Store last successfully embedded item index in `prism_meta` table
- On restart: resume from checkpoint, don't re-process
- Log: "Resuming embedding from item 2,847 of 6,012 (47% already complete)"
- `prism embed --reset` flag to force full re-embed
- Edge case: if items table changed since last embed (new scan), detect and warn

**`prism init` improvement (simple version)**
- Better defaults and clearer prompts
- Generate `prism.config.yaml` and `.env` with sensible values
- If no providers detected: explain the zero-cost setup path (Jina + OpenCode Zen)
- Deliberately minimal — full auto-detection (Ollama sniffing, env var scanning) is v0.10
- Note: `init` touches three milestones (0.9 simple → 0.10 auto-detect → 1.0 quickstart verification). Each iteration should extend, not rework, the previous version.

**`prism doctor`**
- Lightweight diagnostic command
- Checks (in order): config valid → GitHub token works → embedding provider reachable → LLM provider reachable → DB exists → sqlite-vec loads → embedding dimensions match config → embedding model matches config
- Report: green checkmark pass, red X fail, yellow warning non-critical
- Each failure includes remediation message (reuse Phase 4 patterns)
- Item counts, last scan date, embedding coverage percentage

**Matryoshka dimension benchmark**
- Run dupe detection on OpenClaw corpus at 512 dims vs 1024 dims
- Compare: cluster count, cluster membership overlap, precision on a spot-check of 20–30 clusters
- Document results — this either confirms the 1024→512 switch for v0.10 or kills it with data
- No default change in v0.9, just the benchmark

### 0.9.3 — CLI Polish

Scope is deliberately tight. Depth features moved to v0.10.

**`--top N` flag on rank/triage**
- Currently hardcoded to 20
- `prism triage --top 5`, `prism rank --top 50`
- Type: positive integer, default: 20

**`dupes --cluster <id>` error handling**
- When cluster ID not found: show available cluster IDs with item counts
- "Cluster 47 not found. Available clusters: 1 (4 items), 2 (3 items), ... 674 (2 items)"
- Truncate display if >20 clusters, show total count

**`--output markdown` flag**
- Add to: triage, dupes, vision
- Produces formatted markdown for pasting into GitHub issues/discussions
- `--json` is UNCHANGED — different purpose (machine-readable for piping to jq)
- If both `--json` and `--output markdown` are passed: error with clear message

### v0.9 Definition of Done

- [ ] `npx pr-prism triage` works from a clean npm install on Node 20+
- [ ] GitHub Actions badge shows green on README
- [ ] CI includes smoke test against fixture DB
- [ ] At least one GitHub Release published with CHANGELOG
- [ ] Node 20 compatibility audit complete — no 21+ APIs remain
- [ ] `prism init` guides a new user to a working config
- [ ] `prism doctor` checks all provider connectivity and DB health
- [ ] Embedding can crash and resume without re-processing
- [ ] Every provider error message tells the user what failed, why, and what to do
- [ ] `--top N` works on rank and triage
- [ ] `--output markdown` works on triage, dupes, and vision
- [ ] `dupes --cluster` shows available clusters on invalid ID
- [ ] Matryoshka 512 vs 1024 benchmark complete with documented results
- [ ] Commits are granular (not squashed) from this point forward
- [ ] Tag v0.9.0, update CLAUDE.md with all new CLI flags

---

## v0.10 — Depth & Multi-Repo

**Theme:** Features that make PR Prism powerful for daily use by real maintainers.
**Gate:** "Would I use this daily?"
**Effort:** 3–5 focused sessions

### 0.10.1 — Multi-Repo Support

**Config schema extension**
```yaml
# New: multi-repo
repos:
  - owner/repo1
  - owner/repo2
  - owner/repo3

# Backward compatible: single-repo still works
repo: owner/repo
```

**Pipeline iteration (the real work)**
- DB schema is already multi-repo capable — no migration needed
- scan, embed, dupes, rank, vision must iterate over repos and aggregate correctly
- `prism scan` iterates all configured repos
- `prism dupes` clusters across all repos by default
- `prism dupes --repo owner/repo1` scopes to single repo
- Cross-repo dupe display: `[owner/repo1] #1234 ↔ [owner/repo2] #567`
- Cross-repo similarity threshold may need tuning — cross-repo PRs naturally score slightly lower even when semantically identical

**Cross-repo vision alignment**
- Single VISION.md applied across all repos (default)
- Per-repo override:
  ```yaml
  vision_docs:
    owner/repo1: ./VISION_1.md
    owner/repo2: ./VISION_2.md
  ```

### 0.10.2 — Embedding Model Safety & Init

**Embedding metadata table (`embedding_meta`)**
- Fields: model_name, dimensions, embedding_date, item_count, config_hash
- Written on every embed run, queried on every read operation
- Note: VectorStore.init() already validates stored model vs current model. This table adds config_hash tracking and historical metadata — more robust, but core safety check already exists.

**Matryoshka as default (1024 → 512 dims)**
- Only if v0.9 benchmark confirmed stability (this is a data-driven decision, not a roadmap commitment)
- If confirmed: `embedding_dimensions: 512` as default in config
- **Migration path:** detect dimension mismatch → prompt user to `prism embed --reset` with clear explanation
- Document tradeoff: ~2x storage reduction, measured quality impact from benchmark

**`prism init` full auto-detection (promoted from v0.9)**
- Detect: Is Ollama running? Which models are pulled? Which API keys are in env vars?
- Recommend best available option based on what's actually present
- Handle edge cases: Ollama running but no embedding model pulled, multiple API keys present
- Build on top of v0.9's simple init — extend, don't rewrite

### 0.10.3 — Review Depth

**Review storage schema**
- Review results stored in DB: PR/issue number, repo, provider, model, timestamp, structured output (summary, concerns, recommendation)
- Batch review: `prism review --top 10`
- Historical review lookup: `prism review --show 1234`

**`review` works on issues (not just PRs)**
- Issues don't have diffs — review focuses on: description quality, label coverage, linked PRs, staleness, duplicate likelihood
- `prism review --issue 1234` or `prism review --top 10 --type issue`

### 0.10.4 — Scoring & Vision Depth

**Cluster scoring upgrade**
- Integrate full `scorePR` signals (CI, reviews, tests, author history, diff size) for cluster ranking
- Currently uses recency + description length only

**Vision report per-item detail**
- Which specific PRs/issues are aligned, drifting, or off-vision
- Which vision document section each item maps to
- `prism vision --output markdown --file vision-report.md`

**`prism vision --stats`**
- Distribution histogram: aligned / drifting / off-vision counts
- Which vision document sections get the most matches
- Demo-friendly — screenshot-ready terminal output

**Score explainability**
- Every scored item shows signal breakdown: `recency: 0.9 | ci: 1.0 | reviews: 0.8 | tests: 0.95 | vision: 0.88`
- Displayed in triage, rank, and review output
- Helps users tune config weights with actual feedback

### v0.10 Definition of Done

- [ ] `repos: [a, b, c]` config works end-to-end: scan, embed, cluster, rank, vision across repos
- [ ] Cross-repo dupe clusters display with repo context
- [ ] Single-repo backward compatibility preserved
- [ ] Embedding metadata table written on every embed, queried on every read
- [ ] Matryoshka default decision made based on v0.9 benchmark data
- [ ] `prism init` detects available providers and recommends best option
- [ ] Review results persist in DB with full schema
- [ ] `prism review --issue 1234` produces useful output
- [ ] Cluster scoring uses full scorePR signals
- [ ] Vision report shows per-item detail with section mapping
- [ ] `prism vision --stats` renders histogram in terminal
- [ ] Score breakdown visible on every scored item
- [ ] Tag v0.10.0, update CLAUDE.md

---

## v1.0 — Launch-Ready

**Theme:** Everything a stranger needs to discover, understand, trust, and adopt PR Prism in under 5 minutes.
**Gate:** "Would I star and share this?"
**Effort:** 2–3 focused sessions

### 1.0.1 — README Rewrite

The README is the landing page. Most people will never run the tool.

**Structure (in order):**
1. One-line pitch (already strong in repo description)
2. Badge row: build status, npm version, license, Node version
3. Problem statement: 2–3 sentences ("built because" line is already good voice)
4. Terminal GIF: show `prism triage` output on a real repo
5. Mermaid pipeline diagram: scan → embed → cluster/rank/vision → triage
6. 4-command quickstart: `npm install -g pr-prism && prism init && prism scan && prism triage`
7. "Why PR Prism" section: local-first, zero-cost default, multi-provider, multi-repo, cross-repo dupes
8. Commands reference (update existing)
9. Provider table (update existing)
10. Architecture notes (add mermaid)
11. Contributing link
12. License

**Key changes:**
- Add "who this is for" line: maintainers, triage teams, anyone staring at a 4-digit PR count
- OpenClaw proof point ("40% duplicate rate on 6K items") should be prominent, not buried
- Kill `git clone` quickstart — by v1.0 it's `npm install -g pr-prism`
- Cross-repo dupe detection as a headline feature

### 1.0.2 — Terminal Recording

- Record with `asciinema` or `vhs` (charmbracelet):
  1. `prism init` (first-run setup)
  2. `prism scan` (progress indicator on a real repo)
  3. `prism dupes` (actual duplicate clusters with repo context)
  4. `prism triage --top 5` (full pipeline with score breakdown)
- Convert to GIF for README embed
- This single asset does more for adoption than any feature

### 1.0.3 — Discoverability & Social Proof

**GitHub topics:** `pr-triage`, `duplicate-detection`, `github-tool`, `cli`, `devtools`, `open-source`, `maintainer-tools`

**npm keywords:** mirror GitHub topics + `pull-request`, `code-review`, `embeddings`, `similarity`

**GitHub Release v1.0.0**
- Full changelog from v0.5 through v1.0
- Highlight reel: key stats, architectural decisions, proof points
- Pin the release

**Proof points (optional but high-leverage)**
- Run PR Prism against 3–5 well-known repos with large PR counts
- Publish results as GitHub Discussion or blog post
- "We ran PR Prism against [repo] and found X% duplicates across Y items"

### 1.0.4 — Final Polish

- `prism --version` returns actual semver from package.json
- `prism help` output is clean, consistent, complete
- `--state` filter on scan: `--state open` (explicit default), `--state all` (includes closed). No date filtering — `--since` is post-1.0 scope (touches GraphQL query builder and DB storage for closed items)
- `prism stats` command: items by repo, embedding coverage, cluster count, last scan date, model metadata
- **Dependency audit:** verify all deps are MIT/Apache-2.0 compatible. Document sqlite-vec alpha status — pin version, note the risk, don't block launch.

### v1.0 Definition of Done

- [ ] README follows the structure above with GIF, mermaid diagram, badge row
- [ ] `npm install -g pr-prism && prism init && prism scan && prism triage` works end-to-end for new user
- [ ] Terminal recording embedded in README
- [ ] GitHub Release v1.0.0 published with full changelog
- [ ] GitHub topics and npm keywords set
- [ ] `prism --version` and `prism help` polished
- [ ] `prism stats` gives useful overview of local state
- [ ] `--state open|all` works on scan (no date filtering)
- [ ] Core pipeline importable as library (verified, not assumed)
- [ ] Dependency audit complete, sqlite-vec status documented
- [ ] All v0.9 and v0.10 definitions of done still pass

---

## Sequencing Summary

| Milestone | Theme | Key Deliverables | Gate | Effort |
|-----------|-------|-----------------|------|--------|
| **v0.9** | Credibility & Packaging | npm publish, CI + smoke test, Node 20 compat, error UX, progress persistence, `doctor`, Matryoshka benchmark, `--output markdown`, `--top N` | "Would I clone this?" | 2–3 sessions |
| **v0.10** | Depth & Multi-Repo | Cross-repo dupes (0.10.1), embedding safety + full init (0.10.2), review storage + issues (0.10.3), cluster scoring + vision stats + explainability (0.10.4) | "Would I use this daily?" | 3–5 sessions |
| **v1.0** | Launch-Ready | README rewrite, terminal GIF, GitHub Release, discoverability, `stats`, `--state`, dependency audit | "Would I star and share this?" | 2–3 sessions |

---

## Post-1.0 Horizon (noted, not scoped)

Architecture through v1.0 must not preclude any of these:

- **GitHub Action** — comment on new PRs with dupe matches and triage scores (core pipeline must be importable as library — verified in v1.0 DoD)
- **Webhook/watch mode** — continuous triage on PR events
- **Web dashboard** — visual explorer for clusters, vision alignment, triage history
- **Config-as-code for teams** — shared `.prism/` directory in repos
- **Plugin system** — custom scoring signals, custom providers, custom output formats
- **Benchmarking suite** — precision/recall on dupe detection against manually-verified ground truth
- **`--state` date filtering** — `--since 30d` for auditing recently-closed PRs (requires GraphQL query builder changes + closed item storage)

---

## Adoption Strategy

1. **Ship PR Prism against visible repos.** Run it against OpenClaw, OpenCode, or any repo with a public PR problem. The results are the marketing.

2. **The zero-cost story is your wedge.** Most dev tools require API keys, accounts, or money. PR Prism's default stack costs $0. Lead with that.

3. **Target the maintainer pain point directly.** Don't market as "AI-powered PR triage." Market as "your repo has 2000 open PRs and 40% are duplicates. here's proof."

4. **The terminal GIF is the most important asset you'll create.** Invest time making it look good.

5. **Cross-repo dupe detection is the differentiator.** No other free tool does this. When v0.10 ships, that's the headline.
