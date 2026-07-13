# v3.0.0 release design

approved by joe 2026-07-13 ("approved, ship it"). scope: ship the merged hardening spine (35 commits on main since 2.0.1) as a release, plus release automation.

## decisions

- **version: 3.0.0.** the spine includes `feat(write-gate)!` - the webhook server now writes only under `PRISM_APPLY=1` (previously unconditional) and CLI label writes default to dry-run. that's a real behavior break for anyone running the server, so honest semver says major.
- **release path: tag-push GitHub Action, live for this release.** joe set the `NPM_TOKEN` repo secret (granular npm token, expires ~2026-10-07). manual publish stays as fallback.

## sections

1. **version + changelog** - package.json 2.0.1 -> 3.0.0, CHANGELOG 3.0.0 entry with breaking section leading.
2. **package hygiene** - `tsconfig.build.json` excludes `__tests__` (npm package stops shipping compiled tests); build script cleans `dist/` first (kills the 2.0.1 orphan-file gotcha); `repository`/`homepage`/`bugs` fields added (required for `npm publish --provenance`); new `typecheck` script keeps tests + server type-checked now that the build excludes them.
3. **release action** - `.github/workflows/release.yml`, trigger: tag push `v*` only. privileged (NPM_TOKEN) but not fork-reachable (no pull_request_target/workflow_run; forks can't push tags). actions pinned to commit SHAs, minimal permissions (`contents: write` for the GitHub Release, `id-token: write` for provenance). guard step asserts tag == package version. ci.yml gets SHA-pinned in the same pass.
4. **brew tap** - manual bump this round: formula -> v3.0.0 tarball + real sha256, push.
5. **docs** - README (broken node badge -> prism-triage, starmap/housekeeping/init flags, confidence tiers + confirmed tier in the dupe-detection section), docs/ROADMAP.md replaced with a slim post-3.0 horizon, ARCHITECTURE.md gains a release section + GAT rotation note.
6. **gates** - no runtime behavior changes, so no verify-change. voice-check on public prose, marko on the PR diff, CI green, then merge -> tag -> Action publishes -> verify for real (npm view = 3.0.0, npx clean-install, pack list clean, Release exists) -> brew -> vault.

## star-map compatibility

release ships only already-merged additive contract changes. `STARMAP_SCHEMA_VERSION` stays 1; old snapshots keep parsing. this release is what makes the new fields installable for the consumer.
