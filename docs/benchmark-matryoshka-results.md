# matryoshka dimension benchmark

**date:** 2026-03-04
**corpus:** openclaw/openclaw (2000 items — PRs + issues)
**model:** qwen3-embedding:0.6b (1024 native dims)
**threshold:** 0.85

## results

| metric               | 1024 dims | 512 dims  | delta   |
|----------------------|-----------|-----------|---------|
| clusters             |       180 |       194 |     +14 |
| items in clusters    |       519 |       570 |     +51 |
| avg cluster size     |       2.9 |       2.9 |         |
| membership overlap   |       519 |       570 |         |
| jaccard similarity   |           |           |  91.1%  |

best-pick agreement (top 20 clusters): 18/20

storage: ~3.9MB at 512 vs ~7.8MB at 1024 (2x reduction)

## analysis

512 dims produces nearly identical clusters to 1024 dims:

- 91.1% jaccard similarity on cluster membership — well above the 90% threshold for "safe to switch"
- 18/20 top cluster best-picks are the same
- 512 finds 14 more clusters (194 vs 180) — slightly more aggressive splitting, which is acceptable
- 51 more items classified as duplicates — minor increase, direction is correct

## recommendation

**switch to 512 dims as default in v0.10.** the quality tradeoff is negligible and storage halves. migration path: detect dimension mismatch → prompt user to `prism embed --reset`.
