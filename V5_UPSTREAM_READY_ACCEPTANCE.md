# V5 upstream readiness acceptance

Decision: **GO for a later local fork-main fast-forward on Node 22+ and GO for opening one upstream PR.**
This is a source-candidate acceptance, not authorization to merge, push, open that PR or publish.
The upstream PR must explicitly disclose the deliberate minimum-Node increase from upstream's
`>=20.0.0` to `>=22.0.0`. Node 20 is diagnostic only, not a supported SDK deployment target.
No unresolved P0, build, ancestry or CLI-routing blocker remains in the tested candidate.

## Provenance and ancestry

- Source V5: `887ee7375034eef0e201fb191b0acab5c0c8fdda`.
- Fetched upstream: `12c8ef11d2cf4cb1e0ed79200cf5b44ee0a70e3c`.
- Fetched fork main and local main: `e606690b7aa8e3f8a1304a72ce8c0dd43bb56a0c`.
- Hardening branch: `harden/v5-upstream-ready-2026-10-28`.
- Worktree: `/home/alteixeira20/Projects/pr-prism-v5-upstream-ready`.
- Tested runtime commit: `bb3014a58a295e02b36499681de3d0dc4e8bd850` (parent is exact source V5 above).
- Final acceptance HEAD is the documentation-only child of that runtime commit. Resolve its exact
  SHA with `git rev-parse harden/v5-upstream-ready-2026-10-28`; the final handoff and private
  `final-state.json` pin it explicitly, avoiding a self-referential hash in this document.

Both remote fetches exited 0. `git merge-base --is-ancestor` returned 0 for upstream, fork main
and source V5 against the candidate. At preflight, `upstream/main...V5` was `0 47`,
`origin/main...upstream/main` was `0 20`, and `origin/main...V5` was `0 67`.
The twenty commits were already contained in V5. No remerge or rebase occurred, no conflicts
were introduced, and all original history remains intact. With the runtime and report commits,
the final candidate is 49 ahead / 0 behind upstream and 69 ahead / 0 behind fork main.

Conflict resolution table: **none**; no divergent history needed merging. The corrected mission
was executed from V5, rather than manufacturing a merge of already-contained upstream commits.

Final cumulative diffstat against upstream: `182 files changed, 44679 insertions(+), 2141 deletions(-)`.
The complete per-file inventory and original 47-commit history are recorded privately in
`file-audit.csv`, `47-commits.txt`, and `accepted-cumulative.patch`.

## Cumulative audit and upstream-facing changelog

The audit covered the complete original ahead history and changed-file inventory, with targeted
source examination of integration boundaries and executable regression coverage across the tree.
It does not claim live GitHub/provider validation. The 47 commits include several merge commits;
47 commits do not mean 47 independent product features.

| Scope across the cumulative candidate | Files | Audit / preservation evidence |
| --- | ---: | --- |
| CLI and GitHub module extraction, bounded feeds | 53 | Single command registration factory; original CLI options retained; GraphQL, REST normalization, retries and write-gate regressions |
| Optional advisory Jev decisions | 12 | Disabled by default; conservative routing, schema, sanitizer and assessment tests; SDK engine requirement made explicit |
| V4 maintainer and housekeeping workflows | 23 | Relationships, closure verification, prioritization, worklists, drafts, human-confirmed action gates and end-to-end workflow tests |
| V4 grounded reviews and durable scheduler | 8 | Optional dedicated PR/issue schemas, account leases, budgets and resume tests |
| V5 durable operations | 6 | Dedicated SQLite database, immutable checkpoints, source manifests, bounded attempts, crash recovery and hardened inventory |
| Regression fixtures | 48 | All 36 upstream test files remain; no test skips or recovery cases removed |
| Documentation and historical reports | 17 | Historical acceptance marked superseded; new design, compatibility and final evidence |
| Integration/config/export/package/support files | 15 | Metadata provenance preservation, isolated data-directory selection, Node matrix and package whitelist |

Upstream `src/embeddings.ts`, `cluster.ts`, `relations.ts`, `incident.ts`, `scorer.ts`,
`identity.ts`, `benchmark.ts` and `housekeeping.ts` have identical Git blob identities to upstream.
The geometry fix, complete duplicate candidate search, bot filtering, OpenAI-compatible embedding
endpoints/task prefixes, relationship semantics and incident ranking remain intact. CLI extraction
is backed by characterization and compiled command tests. Pipeline/server metadata changes retain
high-fidelity fields when lower-fidelity REST observations arrive. Existing V4 action adapters
remain explicitly gated; V5 adds no GitHub mutation transport. No needed module or historical branch
was removed to reduce PR size. The cumulative PR remains large and needs feature-grouped review.

## Hardening changes and evidence boundaries

- `src/review-operations/github.ts:106`: paginated listing responses supply metadata-only evidence
  with an explicit limitation and `inventoryOnly`. Metadata/detail comparison hashes shared mutable
  fields; it does not treat absent conversation reads as verification. Inventory/changes retain
  complete Link pagination, duplicate checks, PR filtering and overlapping update feeds.
- `src/review-operations/runner.ts:19`: reconciliation consumes listing metadata rather than full
  `get()` evidence. Two full inventories bracket membership; only previously open items missing
  from a listing need targeted metadata. Already closed history is not repeatedly fetched.
- Periodic probes rotate over at most 100 previously hydrated open items per invocation. The durable
  `probeAfter` cursor prevents starvation; a 251-item fixture covers all items over three invocations
  with exactly 300 probe calls. Changed/deleted comments or linked-fix observations supersede full
  evidence with a pending inventory record, retaining historical jobs/checkpoints.
- `src/review-operations/runner.ts:206`: selected jobs hydrate full evidence, then use the original
  authoritative revalidation before every reservation and finalization. Incomplete source coverage
  becomes partial with **zero new reservations**. Full PR merge-base/tree/blob checks, exact UTF-8
  bytes, renames, large patches, batch hashes and durable manifest checks remain required.
- `src/review-operations/github.ts:43`: 403/429 fail closed with the later of reset, Retry-After and
  a sixty-second minimum cooldown. Reconciliation and selected hydration persist the cooldown;
  a fresh CLI/client respects it without making another HTTP call. Reliable cursors never advance
  after failed scans. There is no automatic retry loop or blocking sleep. Permission errors also
  require operator diagnosis rather than being assumed transient.
- `src/review-operations/store.ts:414`: status exposes inventory-only open items and observation-based
  freshness. Both ETAs are N/A while full evidence sizes remain unknown. No SQLite schema/ledger
  rewrite or V4 database reinterpretation was introduced. Full evidence fingerprints and batch hashes
  are unchanged: the new metadata digest is under excluded `health`, so matching native checkpoints
  remain reusable without rebilling. Legacy unproven source coverage stays advisory.

## CLI and runtime compatibility

| Invocation | Behavior |
| --- | --- |
| `review --queue-db PATH --status --json` | Existing V4 queue status; no inference |
| `review --operations --status --repo OWNER/REPO --type issue --json` | V5 read-only inspection, no credentials required |
| `review --operations-db PATH --status --repo OWNER/REPO` | Explicit V5 database also selects V5 |
| `review --status` | Selector error before credential/config loading; no silent V5 takeover |
| `review --dashboard ...`, `review --recover ...` | Explicit V5 modes; inspection is read-only and recovery is offline |
| `review --all-open --dry-run ...` | Metadata inventory only; ignores provider-account configuration, zero paid calls |
| `review --all-open --max-new-calls N ...` | Explicit bounded review, optional for both PRs and issues |

`src/cli/commands/review.ts:63` selects V5 explicitly. `src/review-operations/cli.ts:50` rejects
mixed V4/V5 modes, multiple operation modes, execution flags during inspection/recovery and
acknowledgement outside recovery. Single-item V4 review, history, top-N, scan, dupes and
`--housekeeping` remain available. Default `--type pr` is retained. Issue classification through
scan/embeddings does not initialize a deep reviewer or require a per-issue LLM call.

Engine decision: **declare `>=22.0.0` consistently in package and lockfile**, matching the already
included `@typesafe-ai/sdk@0.7.0` engine and V4 runtime documentation. No dependency versions changed.
Node 20.0.0 was downloaded from the official Node distribution and SHA-256 verified:
`9e512f1f1cadb3a5e37a10aa2d5e632f93aaf9f37165803e2ed981009970a3d7`.
Its controlled dispatch probe fails with `AbortSignal.any is not a function`, with zero network calls.
Node 20.20.2 passes the offline diagnostic suite, but emits the expected root/SDK engine warnings.
That does not establish supported SDK operation on Node 20. No unsupported `>=20.0.0` claim remains,
and no claim is made that 20.20 was the true language/API minimum. The Node support reduction is an
explicit upstream-facing compatibility change, rather than collateral metadata drift. An upstream
maintainer wishing to retain Node 20 must resolve the SDK support contract separately; this candidate
is accepted for Node 22+ only. Package name/version stay `prism-triage@4.0.0`; release versioning is
for the eventual release process, not an unrequested publication in this branch.

## Measured API scaling

`src/__tests__/review-operations-scaling.test.ts` instruments every GET by route. The independent
installed-CLI transport in `scripts/upstream-ready-package-smoke.mjs` repeats cold and warm scans
against the real compiled installed executable, with unexpected destinations/methods rejected.

| Scenario | 1,158 issues | 451 PRs |
| --- | ---: | ---: |
| Cold `--all-open --dry-run` GETs | 24 | 10 |
| Listing pages per inventory | 12 | 5 |
| Warm unchanged feed, no hydrated evidence | 1 | 1 |
| One-item metadata update feed | 1 | 1 |
| Selected full evidence hydration | 6 | 10 |
| Changed-conversation full hydration | 6 | 10 |
| Paid calls / reservations during cold or warm dry-run | 0 | 0 |
| Status/dashboard/recovery remote calls | 0 | 0 |

The PR selection fixture has zero changed files (10 mutable/comparison GETs); separate integrity
fixtures and the installed package review fixture prove real checksum-backed old/new blobs,
source manifests and two fake review batches. Nonempty PR hydration adds file/tree/blob requests
and can require multiple pages/batches. Ordinary issue selection still costs six GETs plus
pagination/linked fixes; those checks were not removed. Original eager ordinary-issue collection
alone would require at least 6,948 requests before listing overhead.

The issue endpoint can include PR records: a real mixed repository may need more than twelve pages
for 1,158 issues. Measured costs are for these synthetic route fixtures, not a promise of identical
live totals. Completed items also incur periodic mutable probe costs. The 100-item bound is an item
bound, not a global HTTP quota: comments/reviews/files can span multiple pages. With 1,158 hydrated
items, a complete round needs at least twelve successful due invocations. Rate-limit cooldowns and
freshness timestamps remain necessary; no perpetual-freshness or unlimited-throughput claim is made.

Fixtures also cover close/reopen/head/body drift, deleted comments without an updated timestamp,
linked-fix merge invalidation, unsafe/repeated/skipped pagination, interrupted scans with unchanged
reliable cursors, membership movement, 403/429 durable cooldown and source/checkpoint tampering.

## Final validation

| Check | Node 24.22.0 | Node 22.23.4 | Node 20.20.2 (diagnostic) |
| --- | --- | --- | --- |
| Clean npm ci | PASS, exit 0 | PASS, exit 0 | PASS, exit 0, expected engine warnings |
| Full npm run ci | PASS, exit 0 | PASS, exit 0 | PASS, exit 0 |
| Build / lint / typecheck | PASS / PASS / PASS | PASS / PASS / PASS | PASS / PASS / PASS |
| Test files / tests | 78 / 1,200 | 78 / 1,200 | 78 / 1,200 |
| Failed / skipped tests | 0 / 0 | 0 / 0 | 0 / 0 |
| npm pack dry-run / tarball / clean install | PASS / PASS / PASS | PASS / PASS / PASS | PASS / PASS / PASS |
| Installed source-backed review fixture | PASS, 2 fake attempts | PASS, 2 fake attempts | PASS, 2 fake attempts |
| Installed scan/dupes/housekeeping/legacy/V5/scaling/error fixture | PASS | PASS | PASS |

All 27 final matrix steps exited 0. Biome checked 201 files. The twelve added hardening tests bring
the original 1,188 tests to 1,200; no original recovery tests were changed. The three pre-report
archives were byte-identical, 393 files, SHA-256
`c6aebac0c761030a9bb2d0b4b8244f423ec63b062c5981b4f2d493776dae6233`.
This hash identifies the runtime validation package before the completed acceptance report was
inserted. The final report-bearing archive is separately pinned by `report-package-checks.json`.
Its runtime JS is compared byte-for-byte with the validated archives and both installed smoke
helpers are rerun. The final package contains 393 files and retains the unchanged name/version.

Every runtime uses fresh `npm ci`, full `npm run ci` (build, lint, both TypeScript projects,
complete Vitest suite, compiled version/help), package dry-run/pack, a fresh tarball-install project,
and both installed CLI smoke helpers. Runtime tests use an empty credential environment and
`bwrap --unshare-net`; `/home` is hidden except for the isolated development worktree. No real
provider/GitHub application request can leave the namespace. The explicit numeric-IP control
reports kernel `ENETUNREACH`. Public npm/runtime downloads happen only during installation.

The original sixteen recovery tests are preserved, including all eleven actual SIGKILL boundaries,
three competing OS processes with shared budgets/accounts, source sentinels, uncertain-charge
non-retry, schema-5 backup/checkpoint identity and stale-owner fencing. No exactly-once remote
execution claim is made. Partial-source tests now additionally assert zero reservations.

Package contents are restricted to compiled JS/declarations/maps, package metadata, examples,
license and the named public documentation. Tests, SQLite databases, logs, tarballs, real `.env`
and external operator artifacts are absent. The current report is included; historical V5 acceptance
is explicitly marked superseded. Final report-only package refresh is recorded separately so its
archive hash is not confused with the pre-report validation archive.

Private evidence: `/tmp/prism-v5-hardening-evidence` (mode 0700, outside Git). Authoritative final
runtime logs use `accepted-*`; older `ci-*`/`final-*` logs are intermediate evidence, not the final gate.
`accepted-matrix.json` records step exit codes. `file-audit.csv`, `preserved-upstream-blobs.json`,
`test-preservation.json`, `node20.0-dispatch-probe.json`, `kernel-denial.json`, final package metadata,
and `final-state.json` support independent review. Helpers and regression tests are committed;
private logs contain only synthetic data and are not packaged or committed.

## Remaining limits and non-mutation

- Binary/non-UTF-8/submodule, unavailable/oversized objects and incomplete GitHub inventories remain
  partial; full text/source coverage is never fabricated or paid for as complete evidence.
- GitHub reads are not a transaction. Current means the recorded authoritative observation; scans
  and rotating probes are bounded polling, with explicitly delayed freshness for large hydrated sets.
- An uncertain paid attempt retains its charge and blocks automatic retry/account reuse until
  explicit acknowledgement. Checkpoint/export durability does not prove remote exactly-once work.
- V5 does not import the external Python reviews of 451 PRs and cannot claim reuse of those paid
  reviews. No automatic import, production migration, GitHub posting/approval/merge/close or billing
  occurred. Review drafts and source backups remain untouched.
- Node 20 is outside the declared deployment contract; Node 22+ is required. Opening the upstream
  PR is a proposal of that explicit compatibility change, not a claim that upstream has accepted it.
- The full cumulative PR is intentionally broad because it includes the completed V4 foundation.
  There are no unresolved merge conflicts. The tests establish deterministic offline behavior,
  not live provider quality, GitHub freshness for a real backlog or production performance.

The source V5 branch/worktree remains clean at the expected SHA. Other worktrees, historical
branches, fork main and production artifacts were not changed. Odysseus was not inspected, stopped,
restarted or migrated. No push, PR creation, release, npm publication or paid request occurred.

## Historical publication instructions (superseded on 2026-10-28)

The original acceptance report included a one-time fork-main promotion script using
the old `e606690b` baseline and proposing a new upstream pull request. Those
commands are obsolete and must not be rerun: the fork was already promoted by
non-force fast-forward and the upstream contribution is tracked as
[PR #32](https://github.com/StressTestor/pr-prism/pull/32), using the retained
`harden/v5-upstream-ready-2026-10-28` feature branch as its head.

The preceding acceptance and test tables describe the original pre-publication
checkpoint. Later remediation and actual GitHub CI are recorded below.

## Post-audit CI remediation addendum (2026-10-28)

An independent V4/V5 audit identified actionable findings regarding CI matrix configuration,
OS-level network isolation test handling on containerized/virtualized runners, package distribution
contents, and documentation consistency. This addendum documents the confirmed findings, code
remediations, and validation evidence without modifying the historical acceptance sections above.

### Distinction of validation states

1. **Original local acceptance**:
   - Executed on a Linux host with user namespaces and bubblewrap (`bwrap`) support.
   - Resulted in 78 test files passing (1,200 tests passed, 0 failed, 0 skipped).
   - Bundled 393 files in the npm package archive (including internal V5 planning documents).
2. **Original remote CI failure**:
   - On GitHub-hosted runners where `bwrap --unshare-net` is absent or unprivileged user namespace
     creation is not available by default, the OS-level isolation test unconditionally called
     `assertOsNetworkIsolationSupported()`, causing an unhandled test error and CI job failure.
   - The CI workflow matrix ran `[20.x, 22.x, 24.x]`, contradicting the package declaration of
     `engines.node: ">=22.0.0"`.
3. **Remediation source changes**:
   - `src/__tests__/network-sandbox.ts`: Added structured capability detection via
     `osNetworkIsolationUnsupportedReason()`, `getOsNetworkIsolationDetail()`, and
     `evaluateOsNetworkIsolationMode()`. Failure reasons distinguish non-Linux platforms (`not-linux`),
     missing binary (`bwrap-not-found`), rejected user namespace creation (`namespace-rejected`),
     and execution probe errors (`sandbox-error`). Sandbox unavailability is not attributed solely
     to AppArmor.
   - `src/__tests__/orchestrated-e2e.test.ts`:
     - Normal mode: If OS-level network isolation is unsupported, records an explicit Vitest skip
       via `ctx.skip()` with the diagnostic reason. The test is never reported as verified or passed.
       Other network interception tests in the suite continue running.
     - Strict mode (`STRICT_NETWORK_ISOLATION=1`): Missing bubblewrap or rejected namespaces cause
       a hard test failure; failures are never converted into skips.
     - Supported environment: Executes all four isolation controls (DNS lookup denial, RFC 5737
       TCP `ENETUNREACH`, child subprocess namespace inheritance, and isolated CLI `--version`).
     - Dynamic version assertion: Replaced hardcoded `"4.0.0"` with local `package.json` version read.
     - Added 3 focused capability handling regression tests, bringing the intermediate test count to 1,203; subsequent regression coverage brought the final suite to 1,206.
   - `.github/workflows/ci.yml`:
     - Set `strategy.fail-fast: false`.
     - Matrix restricted to supported `[22.x, 24.x]` (Node 20.x removed from release gating).
     - Added explicit `npm run typecheck` step before `npm test`.
     - Added dedicated `linux-sandbox-verification` job on `ubuntu-22.04` with bubblewrap
       provisioned via package manager, executing the isolation test under `STRICT_NETWORK_ISOLATION=1`.
   - `CONTRIBUTING.md`:
     - Updated minimum Node requirement from `>=20` to `>=22`.
     - Documented that `@typesafe-ai/sdk` and runtime requirements dictate Node 22+ APIs.
   - `package.json`:
     - Removed 4 internal development/acceptance files from the npm package `files` whitelist
       (`V5_UPSTREAM_READY_ACCEPTANCE.md`, `V5_REVIEW_OPERATIONS_DESIGN.md`,
       `V5_REVIEW_OPERATIONS_ACCEPTANCE.md`, `V5_REVIEW_OPERATIONS_IMPORT_PLAN.md`).
     - Files remain tracked in Git; packaged file count reduced from 393 to 389.
4. **New local validation**:
   - Node 24.22.0 (local environment):
     - `npm run build`: PASS, exit 0.
     - `npm run lint`: PASS, exit 0 (201 files checked, 0 errors).
     - `npm run typecheck`: PASS, exit 0 (`tsc --noEmit` and server tsconfig).
     - `npm test`: 78 test files passed (1,206 tests passed, 0 failed, 0 skipped) in the final Node 24 acceptance.
     - `STRICT_NETWORK_ISOLATION=1 npx vitest run src/__tests__/orchestrated-e2e.test.ts`: PASS, 17/17 passed.
     - `npm run ci`: PASS, exit 0.
     - `npm pack --dry-run --json`: 389 entries packaged, 0 internal markdown files packaged.
     - Executable smoke: `node dist/cli.js --version` (4.0.0) and `node dist/cli.js --help` exit 0.
5. **Accurate accounting of test outcomes**:
   - On hosts with working bubblewrap isolation: 1,206 passed, 0 failed, 0 skipped.
   - On hosts without bubblewrap isolation: 1,205 passed, 0 failed, 1 explicitly skipped.
   - Test counts never claim 1,200 (or 1,206) passed when the OS isolation test was skipped.
6. **Remote CI verification on GitHub Actions**:
   - Workflow run: `https://github.com/alteixeira20/pr-prism/actions/runs/40777726306` (run ID: `40777726306`)
   - Trigger commit: `53827651e117f8ff10f533b165757e57adcce5df`
   - Job outcomes:
     - `build (22.x)`: SUCCESS (Node 22.x matrix build, lint, typecheck, test with 1 explicit Vitest skip for unavailable bwrap, CLI smoke)
     - `build (24.x)`: SUCCESS (Node 24.x matrix build, lint, typecheck, test with 1 explicit Vitest skip for unavailable bwrap, CLI smoke)
     - `linux-sandbox-verification`: SUCCESS (`ubuntu-22.04` runner with package-installed bubblewrap; capability probe passed; `STRICT_NETWORK_ISOLATION=1` executed and passed all 4 kernel isolation controls: DNS denial, TCP `ENETUNREACH`, child subprocess namespace inheritance, and isolated CLI `--version`)
7. **Non-claims and boundaries**:
   - No live provider or live GitHub workload verification is performed or claimed.
   - No remote exactly-once execution is claimed.
   - Node >=22 compatibility contract is enforced and documented.

## Published contribution and final remote CI checkpoint (2026-10-28)

- Fork `alteixeira20/pr-prism:main` and retained
  `alteixeira20/pr-prism:harden/v5-upstream-ready-2026-10-28` were both at
  `1c03f1e618d8db9827298d40ca150ea444fcea7a` before this documentation-only update.
  This was a non-force fast-forward. Upstream `StressTestor/pr-prism:main` was
  `12c8ef11d2cf4cb1e0ed79200cf5b44ee0a70e3c`.
- The last tested implementation commit was
  `1c03f1e618d8db9827298d40ca150ea444fcea7a`. Its
  [fork CI run 40778048570](https://github.com/alteixeira20/pr-prism/actions/runs/40778048570)
  completed successfully: build (22.x), build (24.x), and
  linux-sandbox-verification all succeeded. Both regular runners recorded
  **1,205 passed and 1 explicitly skipped**; the strict Ubuntu 22.04 sandbox
  job recorded **17 passed, 0 skipped**, including all four real isolation controls.
- [Upstream draft PR #32](https://github.com/StressTestor/pr-prism/pull/32)
  was opened from the retained feature branch targeting upstream `main`.
  [Upstream PR CI run 40784119407](https://github.com/StressTestor/pr-prism/actions/runs/40784119407)
  completed successfully for the pre-documentation-fix head.
- This final documentation correction does not alter runtime, tests, dependencies,
  or CI configuration. Its new commit and subsequent CI results must be verified
  separately before the PR is marked ready for review.
- No npm publish, release tag, upstream merge, production paid inference, or
  production maintainer-data mutation occurred as part of this publication workflow.
