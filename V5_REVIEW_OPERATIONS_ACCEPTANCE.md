# V5 review operations acceptance

Historical V5 evidence at the SHAs below. Superseded for current upstream readiness by `V5_UPSTREAM_READY_ACCEPTANCE.md`; original results are retained as provenance.

**GO for integration into fork `main`.** All P0 gates below have executable evidence beyond unit tests: source-backed compiled CLI fixtures, actual SIGKILL recovery, competing processes, clean package installations and installed native CLI execution. This is an integration decision, not authorization to merge, push, publish, import production data or take GitHub actions.

## Exact source and provenance

- Existing branch: `feat/v5-review-operations`; existing worktree: `~/Projects/pr-prism-v5-review-operations`. No additional branch or worktree was created.
- Previous verified commit: `4fff3c2f77022b3e49736c1ed00f0f1c2f377a76`.
- Final implementation commit: **`89312b9f4c5734c75a28acef287ae669e9b3a26c`**. Full runtime CI and clean installation tests below ran against this commit. The following acceptance-report commit changes documentation only; the implementation SHA identifies the exact tested code without a self-referential Git hash.
- Main implementation commit: `cc8eeaf350ad98d8ce4e68bf8d13ecda6d1462e4`; final implementation commit indexes item reconciliation after a loaded Node 20 run exposed unnecessary whole-queue reads.
- Maintained V4 base remains `6155452402e4270700c3a86d6585e24e4c8aa247`. Original source stays on `fix/v4-overnight-repair` with its dirty overnight repairs preserved. Those repairs were backed up during the previous phase and were not applied wholesale or modified in this phase.
- Fork main remains `e606690b7aa8e3f8a1304a72ce8c0dd43bb56a0c`; cached upstream main remains `12c8ef11d2cf4cb1e0ed79200cf5b44ee0a70e3c`. Neither was fetched, merged or pushed.

## PASS/FAIL matrix

| Gate | Node 20.20.2 | Node 22.23.4 | Evidence |
| --- | --- | --- | --- |
| P0: source/diff integrity | PASS | PASS | Pinned merge-base/head trees and verified Git blob hashes; complete unique file inventory and per-file source/patch manifest |
| P0: incomplete evidence fails closed | PASS | PASS | Missing/count-mismatched files, truncated trees, corrupt blobs, binary and submodule fixtures never complete current |
| P0: incremental reconciliation | PASS | PASS | Overlapping cursor, bounded updated feed, failed-cursor retention, periodic full scan and conversation deletion probes |
| P0: concurrent maintainer changes | PASS | PASS | Closed/merged, head/base/body/comment changes before dispatch, between batches and after the final batch; linked-fix merge remains advisory |
| P0: crash recovery and uncertain requests | PASS | PASS | Eleven actual SIGKILL boundaries; unresolved requests retain their charge and block automatic retry/account reuse |
| P0: concurrent budget/ownership | PASS | PASS | Three competing OS processes with distinct or identical accounts; shared budget, fencing and atomic reservations |
| P0: checkpoint compatibility | PASS | PASS | Schema-5 backup and migration retain exact checkpoint hashes and ledger counts; interrupted committed checkpoints are reused |
| P1: status/dashboard | PASS | PASS | Shared read-only WAL snapshot, active batch/account, budgets, throughput/ETA, current/missing/stale/partial/failed counts; no inspection requests |
| `npm run build` | PASS, exit 0 | PASS, exit 0 | Executed by repository CI |
| `npm run lint` | PASS, exit 0 | PASS, exit 0 | 200 source files checked |
| `npm run typecheck` | PASS, exit 0 | PASS, exit 0 | CLI and server TypeScript projects |
| `npm test` | PASS | PASS | **77 files, 1,188 tests, zero failures on each runtime** |
| `npm run ci` | PASS, exit 0 | PASS, exit 0 | Full checks plus compiled version/help |
| `npm pack --dry-run --json` | PASS, exit 0 | PASS, exit 0 | 392 files; native operations JS/types/maps and V5 documents included |
| Clean tarball `npm install` | PASS, exit 0 | PASS, exit 0 | Fresh isolated npm project and ABI-matched native SQLite build on each runtime |
| Installed CLI version/help/issue JSON status | PASS, exit 0 | PASS, exit 0 | No pre-existing operator state or credentials |
| Installed CLI offline backlog/recovery fixture | PASS, exit 0 | PASS, exit 0 | Dry-run: 0 paid calls; complete verified PR: 2 fake calls; inspection/recovery: 0 remote calls; resume: 0 extra paid calls |
| Kernel network-denial negative control | PASS | PASS | Direct socket to numeric IP fails with kernel `ENETUNREACH` inside the isolated network namespace |
| `git diff --check` | PASS | PASS | No whitespace errors |

Additional regression gate: Node **24.22.0** also passes full `npm run ci`, 77 files / 1,188 tests / exit 0. Node 20/22 binaries were downloaded into disposable storage from the official Node distribution and verified against its SHA-256 manifest. Node 20.20.2 archive checksum: `df770b2a6f130ed8627c9782c988fda9669fa23898329a61a871e32f965e007d`; Node 22.23.4: `1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce`. No global runtime or installed release was changed.

Implementation tarballs were byte-identical across Node 20/22 builds: SHA-256 `f7ca3d9a01bc71acd780d87c10ba6d65d9bcc158a255c3dfe3a75b129b4d9e09`, 392 files. This hash identifies the tested implementation archive before this documentation-only acceptance update; final package metadata is captured separately after the update. Content checks exclude source tests, SQLite databases, logs, real `.env`, raw operator data and credentials.

## Verification method and reproducibility

All CI tests ran with network access disabled and a sanitized environment. Linux `bwrap` mounted `/` read-only, with only this development worktree and disposable temporary directories writable. Each runtime used its own compiled native SQLite binding, mounted over the dependency only inside its sandbox. The original checkout, production databases and installed release were outside writable mounts. Dependency installation downloaded public packages in separate disposable npm projects; application tests and installed CLI fixtures remained offline.

Actual commands inside the selected runtime environment:

```sh
npm run ci
npm pack --dry-run --json
npm pack --json --pack-destination DISPOSABLE_PACKAGE_DIRECTORY
# In a fresh disposable npm project under the same runtime:
npm install /path/to/local/prism-triage-4.0.0.tgz --no-audit --no-fund
node node_modules/prism-triage/dist/cli.js --version
node node_modules/prism-triage/dist/cli.js review --help
node node_modules/prism-triage/dist/cli.js review --status --repo example/project --type issue --json
# From the development checkout, with the installed CLI path:
node scripts/review-operations-package-smoke.mjs /path/to/installed/dist/cli.js
```

The package smoke helper preloads a strict fake GET-only GitHub transport and one fake model endpoint; all unexpected destinations/methods throw. It executes the installed CLI, not an imported mock command. The reviewed PR includes actual checksum-verified fake blobs, tree paths and a complete manifest. It verifies zero dry-run attempts, exactly two charged fake dispatches, current completion, status/dashboard/recovery with zero remote calls, and zero additional calls on resume. All model findings remain unverified.

The installed Node 22 dashboard was additionally executed in a real PTY against a disposable fixture, rendered current/total, budget, checkpoint and sync data, refreshed, and exited on Ctrl+C. Direct native CLI Ctrl+C exit was 0. The sandbox supervisor itself can report exit 1 when it also receives terminal SIGINT; that supervisor result is not used as the native CLI exit gate. Fixture workers/ledger were unchanged. Automated tests cover terminal width/height, N/A throughput, active item/batch/account, distinct bounded/backlog ETA, stale/closed items and simultaneous WAL writer/read-only inspection.

Private validation evidence is retained outside Git in a disposable validation directory: `verified-matrix.json`, `ci-final-node-20.log`, `ci-final-node-22.log`, `ci-final-node-24.log`, `install-final-node-20.log`, `install-final-node-22.log`, `fixture-final-node-20.log`, `fixture-final-node-22.log`, runtime package JSON and local tarballs. No raw private responses or live databases are committed.

An intermediate Node 20 CI run hit the previous five-second large-inventory fixture deadline during load. The final implementation replaced per-item whole-queue reads with an indexed item query and gave that 1,611-item durable integration fixture an explicit 30-second I/O deadline. Final full suites passed without reducing assertions or skipping tests.

## P0 evidence details

`review-operations-integrity.test.ts` exercises complete before/after source with missing and truncated patches; added empty files; renames; deletions; a 205-file paginated inventory; 264k source characters split into bounded batches and reconstructed exactly; source hash tampering; unavailable/binary/submodule evidence; and head/base/comment movement during collection. Completion requires a validated manifest, every durable batch checkpoint and final authoritative confirmation. Missing API evidence is partial, never complete. Original patch content is preserved and hashed even when verified full sources supply the missing patch context. Immutable object reuse is tested while mutable metadata/conversation remain fresh.

Incremental tests prove cursor overlap, discovery of new items, preservation of stale history, closed/merged/reopened state, head/body/comment changes, failed scan cursor retention, periodic full reconciliation, and competing scan exclusion. Deleted issue comments are detected even when the item's update timestamp and incremental feed do not change. A linked PR merge invalidates waiting issue evidence without closing the issue. Existing maintainer approval is recorded but does not suppress an independent PR-Prism review.

`review-operations-recovery.test.ts` launches real child processes and kills them with SIGKILL at these eleven boundaries:

1. Claim committed, before reservation.
2. During the budget-reservation transaction, before commit.
3. Reservation committed, before dispatch.
4. Provider simulator observed the request, before a result checkpoint.
5. During the SQLite checkpoint transaction.
6. Checkpoint committed, before worker release.
7. During draft temporary-file publication.
8. JSON draft linked, before Markdown publication.
9. Markdown linked, before finalization.
10. Immediately before completed-state commit.
11. Completed-state commit, before ownership release.

Uncommitted SQLite changes roll back. A committed reservation without a committed result becomes uncertain; it is never refunded or retried automatically. A known checkpoint is reused without another call after remote revalidation. Orphan drafts say pending final confirmation and cannot establish completion. A three-process test enforces a shared five-attempt cap with distinct accounts and with one shared account. A timeout blocks another job using the same credential alias. Wrong-kind acknowledgement and stale-owner dispatch/completion are rejected. Disposable sentinels and a source-file checksum survive every kill test.

Schema-5 compatibility is verified with a consistent backup, retained exact batch/model identity and unchanged paid counts. Recovery has no provider dependency. Explicit acknowledgement preserves the original uncertain attempt and writes an audit event; a later separately bounded run may reserve another request. **There is no exactly-once paid execution claim.** A provider may have accepted a request whose result was never durably recorded.

## Remaining limitations — non-blocking for this integration scope

- Binary/non-UTF-8/submodule content, inaccessible or API-oversized objects, truncated trees and incomplete remote inventories remain partial and require human/source follow-up. Full text coverage can be completed only when verified pinned source evidence exists.
- Reconciliation is bounded polling: five-minute cursor overlap and conversation probes, six-hour full membership checks, plus authoritative checks before each dispatch and finalization. GitHub cannot provide a transaction spanning a remote read and local commit; current means current at the recorded final observation.
- Uncertain remote execution cannot be recovered automatically. Operator acknowledgement authorizes retry planning and possible additional cost; it does not prove the earlier request never reached the provider.
- ETA ranges are indicative, not statistical confidence intervals. Costs are absent unless reported through a provider adapter. Atomic draft publication requires filesystem hard-link and sync support; failures retain checkpoints and fail closed.
- Findings and linked-fix/duplicate allegations remain unverified recommendations. Prompt framing is not proof of injection immunity. GitHub write/action execution, branch protection evaluation for future writes, upstream reconciliation, publication and production draft import remain separately gated work, not missing behavior in this read-only operations phase.
- No production backlog was reviewed or imported in this phase. This GO concerns the implemented source and documented contracts under deterministic API/provider fixtures, real process interruption and runtime/package execution evidence.

## Non-mutation and final state

Only the existing V5 branch was edited/committed. Original dirty source and untracked repairs remain intact. No provider credentials were accessed for development or verification; all application endpoints used fake credentials and fixtures. No paid provider requests, production SQLite mutations, production draft changes, global npm installation changes, fork-main/upstream changes, pushes, branch deletions, GitHub comments/labels/reviews/merges/closes or releases occurred.

Process-only observation near the end found no matching reference Python runner/dashboard. No process was stopped, restarted or modified; no live logs or database contents were inspected. Absence from that process listing does not prove backlog completion or current-head coverage.
