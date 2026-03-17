````
# PR Prism — Full Codebase Audit, Hardening & Build-Out

You are auditing, improving, and expanding PR Prism, a CLI triage tool for open source repos drowning in PRs. It finds duplicates via vector similarity, ranks PR quality, checks vision alignment, and does LLM-powered deep reviews. TypeScript, SQLite + sqlite-vec, multi-provider embeddings and LLM support.

## Setup

Clone the repo into the working directory if not already present:

```bash
cd /Volumes/onn/pr-prism-working-directory
git clone https://github.com/StressTestor/pr-prism.git .
npm install
```

If the repo is already cloned, just make sure you're on `main` and up to date.

## Required Reading — Do This First

Read every file in the project before doing anything else:

1. `README.md` — product overview, architecture, config schema
2. `package.json` — dependencies, scripts, build config
3. `tsconfig.json` — TypeScript config
4. `prism.config.yaml` — default configuration
5. `.env.example` — environment variable schema
6. Every file in `src/` — the entire codebase:
   - `cli.ts` — commander CLI, pipeline orchestration
   - `config.ts` — yaml + env config loading with zod validation
   - `github.ts` — octokit wrapper with rate limiting + backoff
   - `embeddings.ts` — multi-provider embedding (jina, openai, voyage, kimi, ollama)
   - `store.ts` — sqlite + sqlite-vec storage layer
   - `cluster.ts` — duplicate clustering via cosine similarity
   - `scorer.ts` — weighted quality scoring
   - `vision.ts` — vision document alignment checking
   - `reviewer.ts` — LLM-powered deep PR review
   - `labels.ts` — github label management
   - `types.ts` — shared interfaces
7. Everything in `data/` if present

Do not skip files. Do not skim. Read every line. You need the full picture before any analysis.

---

## Workflow: gstack → superpowers audit & build pipeline

This project uses both gstack and superpowers in sequence. gstack handles product and architecture validation. Superpowers handles structured implementation of fixes and new features. Follow this exact sequence.

### Step 1: /plan-ceo-review (gstack — founder mode)

Run `/plan-ceo-review` against the codebase + README. The product thesis is:

> A local-first CLI tool that triages open source PRs at scale — duplicate
> detection via vector embeddings, quality scoring, vision alignment checking,
> and LLM-powered reviews. Runs entirely local except for configurable API
> calls. Zero-cost setup possible via Jina free tier + OpenCode Zen.

Pressure-test these specific questions:

- **Market fit**: Who actually uses this? Solo maintainers of big repos, or triage teams at orgs? Does the tool serve both equally well, or is it splitting focus?
- **Competitive moat**: GitHub Copilot for PRs exists. What stops GitHub from shipping native duplicate detection tomorrow? Is the multi-provider local-first angle enough differentiation?
- **Growth ceiling**: After someone triages their repo once, what brings them back? Is this a one-shot tool or does it have recurring value? What's the retention hook?
- **Missing features that would 10x adoption**: GitHub Action integration? Web dashboard? Slack/Discord bot notifications? API mode for CI pipelines? What's the gap between "useful CLI" and "indispensable infra"?
- **Pricing/monetization path**: The zero-cost angle is great for adoption but bad for sustainability. Is there a paid tier that makes sense? Hosted API? Enterprise features?
- **Naming and positioning**: "PR Prism" — does the name communicate what it does? Is the README landing page optimized for drive-by GitHub visitors?
- **Distribution**: npm package? Homebrew? Docker image? GitHub Marketplace? What's the path to frictionless adoption?

Capture all insights. These feed into the implementation plan.

### Step 2: /plan-eng-review (gstack — eng manager mode)

Run `/plan-eng-review` on the entire codebase. Audit every dimension:

**Architecture & Code Quality:**
- Module boundaries — are responsibilities cleanly separated or is there cross-cutting concern leakage?
- Error handling patterns — are failures graceful? What happens when GitHub API rate limits? When embedding API is down? When SQLite is locked?
- TypeScript strictness — is `strict: true`? Any `any` types lurking? Are interfaces comprehensive?
- Dependency health — are deps up to date? Any known vulnerabilities? Any unnecessary deps?
- Config validation — is the zod schema complete? Does it catch all misconfigurations early?

**Performance & Scalability:**
- SQLite query patterns — are there missing indexes? N+1 queries? Full table scans on large datasets?
- Embedding batch processing — is the batching strategy optimal? What about backpressure when the API rate limits?
- Memory usage during clustering — cosine similarity across 6000+ vectors could blow up. How's it handled?
- Incremental processing — does it skip already-processed items efficiently or re-embed everything?

**Reliability & Edge Cases:**
- What happens with repos that have 0 PRs? 1 PR? 50,000 PRs?
- Unicode in PR titles/bodies — does embedding handle it?
- PRs with no body/description — does scoring degrade gracefully?
- Network failures mid-pipeline — can you resume or do you restart from scratch?
- Concurrent runs against the same database — any locking issues?

**Security:**
- API key handling — are keys only in env vars? Any risk of logging them?
- GitHub token permissions — does it request minimum necessary scopes?
- SQL injection surface — parameterized queries everywhere?
- Dependency supply chain — lockfile integrity?

**Testing:**
- What's the test coverage? Are there any tests at all?
- Which modules are most critical and least tested?
- What would a minimum viable test suite look like?

**Developer Experience:**
- Build pipeline — clean? Any unnecessary steps?
- Error messages — are they actionable or cryptic?
- Documentation — does the README match the actual behavior?
- CLI UX — is the output readable? Progress indicators for long operations?

Output:
1. A prioritized list of findings (critical → nice-to-have)
2. Architecture diagram of current state
3. Data flow diagram showing the full pipeline
4. Dependency graph showing what blocks what for fixes

### Step 3: /superpowers:write-plan (superpowers — planning mode)

Take the CEO review insights from Step 1 and the engineering findings from Step 2. Use `/superpowers:write-plan` to break the improvements into bite-sized tasks (2-5 minutes each).

Prioritize in this order:
1. **Bugs and correctness issues** — anything that produces wrong results
2. **Reliability gaps** — error handling, resume capability, edge cases
3. **Performance bottlenecks** — things that make it unusable at scale
4. **Code quality debt** — TypeScript strictness, missing types, dead code
5. **Testing** — minimum viable test suite for critical paths
6. **DX improvements** — better CLI output, progress bars, error messages
7. **Feature gaps from CEO review** — the highest-impact missing features

Every task needs:
- Exact file paths to modify or create
- What the code should do before and after
- Verification steps (how to confirm it's fixed/built)
- Dependencies on other tasks

This is NOT just a hardening pass — build out the high-impact features identified in the CEO review. If the CEO review surfaces something that would meaningfully improve adoption or retention (GitHub Action, better distribution, API mode, etc.), plan it and build it. Use judgment on scope: if a feature would take 30+ minutes per task, break it into smaller pieces. If it would require a fundamental rewrite of core architecture, flag it for a separate sprint but still scaffold the integration points.

### Step 4: /superpowers:execute-plan (superpowers — subagent-driven development)

Run `/superpowers:execute-plan` to implement the plan via subagent-driven-development. Each task gets a fresh subagent with two-stage review (spec compliance, then code quality).

Constraints during execution:
- Do not change existing CLI command names or flag names without backward-compatible aliases
- Do not change the config schema without backward compatibility (new fields should have defaults)
- Do not change the database schema without a migration path
- New features get their own modules — don't stuff them into existing files unless it's a natural extension
- Commit after each logical unit of work with descriptive conventional commit messages
- Push after every commit

### Step 5: /review (gstack — staff engineer mode)

Run `/review` on the full codebase after all changes. Look for:
- Regressions introduced by the fixes
- Inconsistencies between modules that were edited separately
- Any remaining `any` types, unhandled promises, or error swallowing
- Memory leaks (especially in streaming/batching paths)
- Race conditions in async code

Fix anything found. Commit: `fix: address code review findings`

### Step 6: /qa (gstack — QA lead mode)

Run `/qa` to verify end-to-end:

- `npm run build` completes without errors or warnings
- `npx prism scan` works against a real public repo (use a small one)
- `npx prism dupes` produces reasonable duplicate clusters
- `npx prism rank` scores PRs without crashing
- `npx prism vision` works with and without a VISION.md
- `npx prism review <PR_NUMBER>` produces a coherent review
- `npx prism triage` runs the full pipeline without errors
- `--dry-run` flags work and produce output without side effects
- `--apply-labels` flags work (test against a repo you own)
- Config validation catches bad YAML gracefully
- Missing env vars produce helpful error messages, not stack traces
- Any new CLI commands or features added during the build-out work correctly
- New features have help text (`--help`) and are documented in README

Fix any issues found. Commit: `fix: address QA findings`

### Step 7: finishing-a-development-branch (superpowers)

Use superpowers' `finishing-a-development-branch` skill to wrap up:
- Verify all changes are committed and pushed
- Run the build one final time
- Present options: merge to main, open PR, or keep branch

---

## What Success Looks Like

After this audit and build-out:
1. Every error path in the codebase handles failures gracefully with actionable messages
2. The tool runs reliably on repos with 0 to 50,000+ PRs
3. TypeScript is strict with no `any` escape hatches
4. Critical paths have test coverage
5. The README accurately reflects all current behavior including new features
6. High-impact features from the CEO review are built, tested, and documented — not just roadmapped
7. Distribution is improved (npm publish-ready at minimum, Homebrew/Docker if feasible)
8. The project is in a state where someone discovering it on GitHub can go from `git clone` to useful results in under 5 minutes

Ship it. Don't ask permission.
````
