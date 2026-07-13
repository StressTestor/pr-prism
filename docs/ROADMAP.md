# roadmap

everything through v3.0.0 shipped. [CHANGELOG.md](../CHANGELOG.md) records what landed; this file only tracks what's next.

## post-3.0 horizon

- lock the star-map contract: published JSON schema, `prism starmap --validate`, golden fixtures a consumer's CI can run. compatibility should be machine-checked
- calibration: precision/recall against maintainer keep/not-dup verdicts on a live corpus. does loose/contested actually predict not-a-dup?
- contested review: near-tied clusters auto-run the LLM review pass. bestPick is advisory on a near-tie, and quality signals can't see a semantic placement bug
- live automation: dupe matches + housekeeping suggestions commented on new PRs as they open (webhook server / action already exist, this wires the new tiers in)
- `--since` date filtering on scan: audit recently-closed items without pulling full history
- brew tap bump in the release workflow: formula update is still a manual two-liner per release

## history

the v1.0 launch roadmap this file used to hold (npm publish, CI, versioning, multi-repo, docs) shipped across 0.9-1.0. the 2026-07 hardening spine (determinism, confidence tiers, tracker substrate, git-identity, write-gate, housekeeping manifest, starmap contract) is CHANGELOG 3.0.0.
