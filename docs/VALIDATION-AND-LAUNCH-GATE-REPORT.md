# PR-Prism v4 — Validation, Multi-Provider Credential Configuration & Launch Gate Report

## 1. Executive Summary & GO / NO-GO Decision

- **Stage A–C (Jev-First Triage, Full 1,562-Item Evaluation & Deterministic Escalation Queue)**: **GO (COMPLETE & VALIDATED)**
  - Pinned model `jev-1.14.0` evaluated all **1,562 / 1,562** open Odysseus items (`410` PRs + `1,152` Issues) with **0 failures** in **47.3s** wall-clock (`202 ms` mean latency, `$0.1881 USD` total cost).
  - Deterministic safety gates (`160 / 160 = 100%` escalated) and Stage C Seriousness Floor guarantees verified.
  - Reproducible GLM escalation queue (`891` escalated items: `226` PRs + `665` Issues; `671` routine local-only items) generated and seeded into the durable SQLite review queue.
- **Stage D–F (Multi-Provider Scheduler, Grounded PR/Issue Deep Reviews & Regression Suite)**: **GO (CODE & TESTS COMPLETE)**
  - 5-account scheduler, SQLite atomic `IMMEDIATE` single-lease invariant (`max 1 in-flight request per subscription`), crash recovery, idempotent checkpoints, exponential 429 cooldowns, no account cycling on `400`/`422` rejected requests, dedicated PR vs Issue deep review schemas, and untrusted input isolation (`<UNTRUSTED_GITHUB_DATA>`) implemented and verified across **57 test suites (850 passing tests)**.
- **Unattended Paid 3-Subscription GLM Batch Execution**: **NO-GO (HOLD AT LAUNCH GATE 3 & 5 UNTIL SUBSCRIPTIONS 2 & 3 ARE CONFIGURED/UPGRADED)**
  - Per Launch Gate 3 (*"All configured credentials authenticate independently"*) and Gate 5 (*"Three-account concurrency succeeds"*), unattended batch execution is withheld because Featherless Subscriptions 2 (`sha256=ed4f729ef911`) and 3 (`sha256=5707d8feefbc`) currently return HTTP `403 upgrade_required` (`"You do not have an active subscription. Please upgrade your plan."`), while Subscription 1 (`sha256=c90cb9e6921b`) is active (`HTTP 200`).
  - The durable SQLite review queue (`/home/alteixeira20/Projects/pr-prism-live/odysseus/reports/prism-glm-review-queue.sqlite`) is populated and ready to resume immediately once the 3 subscriptions are configured.

---

## 2. Launch Gate Status Matrix

| Gate | Requirement | Status | Empirical Evidence |
| :--- | :--- | :---: | :--- |
| **Gate 1** | Jev pilot findings and escalation quality evaluated | **PASS** | 160-item stratified pilot (`86.25%` category match, `98.75%` priority within ±1 tier, `18/18` safety gates) and full 1,562-item inventory (`86.81%` category match, `99.68%` priority within ±1 tier, `160/160` safety gates, `0` failures) completed. |
| **Gate 2** | Review prompts and schemas pass tests | **PASS** | `src/__tests__/deep-reviewer-stage-e.test.ts` (20/20 pass): verifies `PRDeepReviewResultSchema`, `IssueDeepReviewResultSchema` (no PR `merge` recommendation reuse), confidence capping (`<= 0.65`) on missing/truncated diff or body, and `<UNTRUSTED_GITHUB_DATA>` tag-breakout neutralization. |
| **Gate 3** | All configured credentials authenticate independently | **BLOCKED (1/3 Active)** | `verifyAccountsIndependently` live probe: `featherless-sub-1` (`sha256=c90cb9e6921b`) -> **HTTP 200 PASS**; `featherless-sub-2` (`sha256=ed4f729ef911`) -> **HTTP 403 `upgrade_required`**; `featherless-sub-3` (`sha256=5707d8feefbc`) -> **HTTP 403 `upgrade_required`**. |
| **Gate 4** | Single-account inference succeeds | **PASS** | Verified on `featherless-sub-1` (`zai-org/GLM-5.3-Flash`, `sha256=c90cb9e6921b`) with HTTP 200 completion and existing grounded Featherless review (`PR #6357` in `odysseus/reports/glm5-flash-single-pr-test.json`). |
| **Gate 5** | Three-account concurrency succeeds without duplicate reviews or uncontrolled HTTP 429 loops | **PASS (Integration) / HOLD (Live)** | Proven in `src/__tests__/review-scheduler-stage-d.test.ts` across 3 and 5 concurrent accounts (`maxObservedInFlightByAccount === 1` per account, `0` duplicates, exponential 429 cooldowns). Live 3-account run held pending Gate 3 credentials. |
| **Gate 6** | Crash recovery and checkpoints pass | **PASS** | Proven in `src/__tests__/review-scheduler-stage-d.test.ts` and verified on `prism-glm-review-queue.sqlite` (`recoverExpiredLeases` + composite `checkpoint_key` idempotency). |
| **Gate 7** | GitHub write protections remain effective | **PASS** | `assertReadOnlyGitHubClient` proxy blocks all mutating methods (`mergePullRequest`, `closeIssue`, `closePullRequest`, `createComment`, `addLabels`, etc.) and rejects `WriteGate` in `"apply"` mode. Canonical `prism.db` and GitHub state remain 100% untouched. |

---

## 3. Configuration & Credential-Handling Instructions

### 3.1 Security Rules
- **Never commit, log, or print raw API keys.** PR-Prism computes a 12-character SHA-256 fingerprint (`computeCredentialFingerprint`) for all audit logs and SQLite usage ledgers (`account_usage_ledger.key_fingerprint`).
- Store credentials in restricted-permission files (`chmod 600`) outside the repository or pass via environment variables at runtime.

### 3.2 TypeSafe Jev Configuration
Provide the TypeSafe API key via either environment variable or key file:
```bash
export TYPESAFE_API_KEY="ts_..."
# OR point to a key file (default fallback: ~/.config/typesafe/jev-api-key):
export TYPESAFE_API_KEY_FILE="$HOME/.config/typesafe/jev-api-key"
```

### 3.3 Multi-Subscription Deep Review Worker Configuration (Up to 5 Accounts)
`loadMultiAccountProfilesFromEnv` in `src/review-scheduler.ts` supports up to 5 independent provider profiles (`REVIEW_ACCOUNT_1_*` through `REVIEW_ACCOUNT_5_*`) or Featherless shorthand variables (`FEATHERLESS_API_KEY_1`..`5` / `FEATHERLESS_API_KEY_FILE_1`..`5`):

```bash
# Option A: Generic Multi-Provider Profiles (supports featherless, openai, kimi, anthropic, ollama, opencode)
export REVIEW_ACCOUNT_1_ID="featherless-sub-1"
export REVIEW_ACCOUNT_1_PROVIDER="featherless"
export REVIEW_ACCOUNT_1_MODEL="zai-org/GLM-5.3-Flash"
export REVIEW_ACCOUNT_1_KEY_FILE="$HOME/.config/featherless/sub1-key"
export REVIEW_ACCOUNT_1_BASE_URL="https://api.featherless.ai/v1"

export REVIEW_ACCOUNT_2_ID="featherless-sub-2"
export REVIEW_ACCOUNT_2_PROVIDER="featherless"
export REVIEW_ACCOUNT_2_MODEL="zai-org/GLM-5.3-Flash"
export REVIEW_ACCOUNT_2_KEY_FILE="$HOME/.config/featherless/sub2-key"

export REVIEW_ACCOUNT_3_ID="featherless-sub-3"
export REVIEW_ACCOUNT_3_PROVIDER="featherless"
export REVIEW_ACCOUNT_3_MODEL="zai-org/GLM-5.3-Flash"
export REVIEW_ACCOUNT_3_KEY_FILE="$HOME/.config/featherless/sub3-key"

# Option B: Featherless Shorthand
export FEATHERLESS_MODEL="zai-org/GLM-5.3-Flash"
export FEATHERLESS_API_KEY_FILE_1="$HOME/.config/featherless/sub1-key"
export FEATHERLESS_API_KEY_FILE_2="$HOME/.config/featherless/sub2-key"
export FEATHERLESS_API_KEY_FILE_3="$HOME/.config/featherless/sub3-key"
```

### 3.4 Verifying Credentials & Resuming the Durable Queue
1. **Verify all configured subscriptions independently (Gate 3 pre-flight check)**:
   ```bash
   node dist/cli.js review --verify-accounts --json
   ```
2. **Resume the seeded 891-item Odysseus durable SQLite queue**:
   ```bash
   node dist/cli.js review --queue-db /home/alteixeira20/Projects/pr-prism-live/odysseus/reports/prism-glm-review-queue.sqlite --json
   ```
   If any configured account fails pre-flight authentication, the CLI exits with code `2` and leaves the SQLite queue untouched and resumable.
3. **Run a single grounded deep review (PR diff or dedicated Issue schema)**:
   ```bash
   # Grounded PR Deep Review (inspects diff + full body)
   node dist/cli.js review 6357 --type pr --deep --json

   # Grounded Issue Deep Review (uses IssueDeepReviewResult schema, never PR merge recommendations)
   node dist/cli.js review 6224 --type issue --deep --json
   ```
