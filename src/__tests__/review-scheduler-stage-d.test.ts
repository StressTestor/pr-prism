import { describe, expect, it } from "vitest";
import { type ClaimedReviewJob, DurableReviewQueue } from "../review-queue.js";
import {
  loadMultiAccountProfilesFromEnv,
  MultiProviderReviewScheduler,
  type ReviewAccountProfile,
  resolveAccountCredential,
  verifyAccountsIndependently,
} from "../review-scheduler.js";

describe("Stage D — Multi-Provider Review Workers & Durable Queue", () => {
  describe("1. Enqueueing jobs and idempotent checkpoint reuse", () => {
    it("skips LLM call on second enqueue or claim when checkpoint matches", () => {
      const queue = new DurableReviewQueue(":memory:");

      // Initial enqueue
      const res1 = queue.enqueueJob({
        repo: "facebook/react",
        itemType: "pr",
        itemNumber: 101,
        title: "Fix ConcurrentMode hydration mismatch",
        priorityBand: "P0_CRITICAL",
        priorityScore: 98.5,
        inputFingerprint: "fingerprint-react-101",
        promptSchemaVersion: "2026-10-triage-v2",
        payload: { diff: "+ console.log('test');" },
      });

      expect(res1.jobId).toBe("facebook/react:pr:101");
      expect(res1.status).toBe("queued");
      expect(res1.checkpointReused).toBe(false);

      // Claim and complete with checkpoint
      const claimed = queue.claimNextJobForAccount("test-account-1", 30_000, 1000);
      expect(claimed).not.toBeNull();
      expect(claimed?.jobId).toBe("facebook/react:pr:101");
      expect(claimed?.attempts).toBe(1);

      queue.completeJobWithCheckpoint({
        jobId: claimed!.jobId,
        accountId: "test-account-1",
        leaseId: claimed!.leaseId,
        provider: "featherless",
        model: "zai-org/GLM-5.3-Flash",
        keyFingerprint: "abc123def456",
        result: {
          summary: "Safe hydration fix",
          concerns: [],
          recommendation: "merge",
          confidence: 0.99,
        },
        promptTokens: 120,
        completionTokens: 45,
        latencyMs: 310,
        nowMs: 1500,
      });

      expect(queue.getJob("facebook/react:pr:101")?.status).toBe("completed");

      // Verify checkpoint exists
      const cp = queue.getCheckpoint("facebook/react", "pr", 101, "fingerprint-react-101", "2026-10-triage-v2");
      expect(cp).not.toBeNull();
      expect(cp?.account_id).toBe("test-account-1");
      expect(JSON.parse(cp!.result_json).recommendation).toBe("merge");

      // Re-enqueue with the exact same fingerprint -> immediately completed with checkpointReused
      const res2 = queue.enqueueJob({
        repo: "facebook/react",
        itemType: "pr",
        itemNumber: 101,
        title: "Fix ConcurrentMode hydration mismatch",
        priorityBand: "P0_CRITICAL",
        priorityScore: 98.5,
        inputFingerprint: "fingerprint-react-101",
        promptSchemaVersion: "2026-10-triage-v2",
        payload: { diff: "+ console.log('test');" },
      });

      expect(res2.status).toBe("completed");
      expect(res2.checkpointReused).toBe(true);

      // Enqueue a fresh job without checkpoint, but inject checkpoint before claim
      queue.enqueueJob({
        repo: "facebook/react",
        itemType: "pr",
        itemNumber: 102,
        title: "Update docstring",
        priorityBand: "P2_MODERATE",
        priorityScore: 60,
        inputFingerprint: "fingerprint-react-102",
        promptSchemaVersion: "2026-10-triage-v2",
        payload: { diff: "docs update" },
      });

      // Simulate external checkpoint insertion for 102
      queue.completeJobWithCheckpoint({
        jobId: "facebook/react:pr:102",
        accountId: "manual-checkpointer",
        leaseId: "external-lease",
        provider: "featherless",
        model: "zai-org/GLM-5.3-Flash",
        keyFingerprint: "fedcba987654",
        result: { recommendation: "merge" },
        nowMs: 2000,
      });

      // Attempting to claim for an account: claimNextJobForAccount will observe the checkpoint and complete it
      const claim2 = queue.claimNextJobForAccount("test-account-1", 30_000, 2500);
      expect(claim2).toBeNull(); // no remaining queued jobs
      expect(queue.getJob("facebook/react:pr:102")?.status).toBe("completed");

      queue.close();
    });
  });

  describe("2. Hard concurrency invariant across 3 and 5 concurrent accounts", () => {
    it("runs 15 jobs across 3 concurrent accounts with maxObservedInFlight === 1 for every account and 0 duplicates", async () => {
      const queue = new DurableReviewQueue(":memory:");

      for (let i = 1; i <= 15; i++) {
        queue.enqueueJob({
          repo: "octocat/Hello-World",
          itemType: "pr",
          itemNumber: i,
          title: `Concurrent PR #${i}`,
          priorityBand: i % 2 === 0 ? "P1_HIGH" : "P2_MODERATE",
          priorityScore: 50 + i,
          inputFingerprint: `fp-concurrent-3-${i}`,
          promptSchemaVersion: "v1",
          payload: { index: i },
        });
      }

      const profiles: ReviewAccountProfile[] = [
        { accountId: "acct-1", provider: "featherless", model: "m", apiKey: "k1" },
        { accountId: "acct-2", provider: "featherless", model: "m", apiKey: "k2" },
        { accountId: "acct-3", provider: "featherless", model: "m", apiKey: "k3" },
      ];

      let activeConcurrentWorkers = 0;
      let maxObservedConcurrentWorkers = 0;
      const executedJobs = new Set<string>();
      const duplicateExecutions: string[] = [];

      const scheduler = new MultiProviderReviewScheduler(queue, profiles, {
        pollIntervalMs: 5,
        workerFn: async (job: ClaimedReviewJob) => {
          activeConcurrentWorkers++;
          if (activeConcurrentWorkers > maxObservedConcurrentWorkers) {
            maxObservedConcurrentWorkers = activeConcurrentWorkers;
          }

          if (executedJobs.has(job.jobId)) {
            duplicateExecutions.push(job.jobId);
          }
          executedJobs.add(job.jobId);

          // Simulated async network delay
          await new Promise((resolve) => setTimeout(resolve, 25));

          activeConcurrentWorkers--;
          return {
            result: { recommendation: "merge", confidence: 0.95 },
            promptTokens: 10,
            completionTokens: 20,
          };
        },
      });

      const result = await scheduler.start();

      expect(duplicateExecutions).toEqual([]);
      expect(executedJobs.size).toBe(15);
      expect(result.completedJobs).toBe(15);
      expect(result.failedJobs).toBe(0);
      expect(result.rejectedJobs).toBe(0);

      // Verify concurrent workers overlapped
      expect(maxObservedConcurrentWorkers).toBeGreaterThanOrEqual(3);

      // Verify HARD CONCURRENCY INVARIANT for each account: exactly 1 in flight max!
      expect(scheduler.getMaxObservedInFlight("acct-1")).toBe(1);
      expect(scheduler.getMaxObservedInFlight("acct-2")).toBe(1);
      expect(scheduler.getMaxObservedInFlight("acct-3")).toBe(1);

      queue.close();
    });

    it("runs 15 jobs across 5 concurrent accounts with maxObservedInFlight === 1 for every account and 0 duplicates", async () => {
      const queue = new DurableReviewQueue(":memory:");

      for (let i = 1; i <= 15; i++) {
        queue.enqueueJob({
          repo: "octocat/Hello-World",
          itemType: "pr",
          itemNumber: 100 + i,
          title: `Concurrent PR #${100 + i}`,
          priorityBand: "P1_HIGH",
          priorityScore: 70 + (i % 5),
          inputFingerprint: `fp-concurrent-5-${i}`,
          promptSchemaVersion: "v1",
          payload: { index: i },
        });
      }

      const profiles: ReviewAccountProfile[] = [1, 2, 3, 4, 5].map((idx) => ({
        accountId: `worker-acct-${idx}`,
        provider: "featherless",
        model: "zai-org/GLM-5.3-Flash",
        apiKey: `key-secret-${idx}`,
      }));

      let activeConcurrentWorkers = 0;
      let maxObservedConcurrentWorkers = 0;
      const executedJobs = new Set<string>();
      const duplicateExecutions: string[] = [];

      const scheduler = new MultiProviderReviewScheduler(queue, profiles, {
        pollIntervalMs: 5,
        workerFn: async (job: ClaimedReviewJob) => {
          activeConcurrentWorkers++;
          if (activeConcurrentWorkers > maxObservedConcurrentWorkers) {
            maxObservedConcurrentWorkers = activeConcurrentWorkers;
          }

          if (executedJobs.has(job.jobId)) {
            duplicateExecutions.push(job.jobId);
          }
          executedJobs.add(job.jobId);

          await new Promise((resolve) => setTimeout(resolve, 30));

          activeConcurrentWorkers--;
          return {
            result: { recommendation: "merge", confidence: 0.98 },
            promptTokens: 12,
            completionTokens: 24,
          };
        },
      });

      const result = await scheduler.start();

      expect(duplicateExecutions).toEqual([]);
      expect(executedJobs.size).toBe(15);
      expect(result.completedJobs).toBe(15);

      // Verify concurrent overlap reached all 5 workers
      expect(maxObservedConcurrentWorkers).toBe(5);

      // Every account strictly satisfied the single-lease invariant
      for (const p of profiles) {
        expect(scheduler.getMaxObservedInFlight(p.accountId)).toBe(1);
      }

      queue.close();
    });
  });

  describe("3. Crash recovery", () => {
    it("recovers expired lease after simulated worker crash and allows another account to finish", () => {
      const queue = new DurableReviewQueue(":memory:");

      queue.enqueueJob({
        repo: "torvalds/linux",
        itemType: "pr",
        itemNumber: 999,
        title: "Crash Recovery Test PR",
        priorityBand: "P1_HIGH",
        priorityScore: 90,
        inputFingerprint: "fp-crash-test",
        promptSchemaVersion: "v1",
        payload: { diff: "crash recovery payload" },
      });

      const startTime = 10_000;
      const leaseDuration = 5_000;

      // Account A claims the job with a 5s lease
      const claimedA = queue.claimNextJobForAccount("crashing-worker", leaseDuration, startTime);
      expect(claimedA).not.toBeNull();
      expect(claimedA?.jobId).toBe("torvalds/linux:pr:999");
      expect(claimedA?.leaseExpiresAt).toBe(15_000);

      // Account A "crashes" — never completes or releases

      // Account B tries to claim at 12_000 (lease still active) -> cannot claim
      const claimedTooEarly = queue.claimNextJobForAccount("standby-worker", leaseDuration, 12_000);
      expect(claimedTooEarly).toBeNull();
      expect(queue.getJob("torvalds/linux:pr:999")?.status).toBe("claimed");

      // Advance time past lease expiration (16_000)
      const recoveredCount = queue.recoverExpiredLeases(16_000);
      expect(recoveredCount).toBe(1);

      // Job is back in queued status
      const jobAfterRecovery = queue.getJob("torvalds/linux:pr:999");
      expect(jobAfterRecovery?.status).toBe("queued");
      expect(jobAfterRecovery?.claimed_by_account).toBeNull();

      // Account B claims the recovered job
      const claimedB = queue.claimNextJobForAccount("standby-worker", leaseDuration, 16_100);
      expect(claimedB).not.toBeNull();
      expect(claimedB?.jobId).toBe("torvalds/linux:pr:999");
      expect(claimedB?.accountId).toBe("standby-worker");
      expect(claimedB?.attempts).toBe(2);

      // Account B finishes successfully
      queue.completeJobWithCheckpoint({
        jobId: claimedB!.jobId,
        accountId: "standby-worker",
        leaseId: claimedB!.leaseId,
        provider: "featherless",
        model: "zai-org/GLM-5.3-Flash",
        keyFingerprint: "fingerprint12",
        result: { recommendation: "merge", confidence: 1.0 },
        nowMs: 16_500,
      });

      expect(queue.getJob("torvalds/linux:pr:999")?.status).toBe("completed");
      queue.close();
    });

    it("heartbeat successfully extends lease expiration", () => {
      const queue = new DurableReviewQueue(":memory:");

      queue.enqueueJob({
        repo: "torvalds/linux",
        itemType: "pr",
        itemNumber: 888,
        title: "Heartbeat PR",
        priorityBand: "P2_MODERATE",
        priorityScore: 70,
        inputFingerprint: "fp-heartbeat",
        promptSchemaVersion: "v1",
        payload: {},
      });

      const now = 20_000;
      const claimed = queue.claimNextJobForAccount("heartbeat-acct", 5_000, now);
      expect(claimed).not.toBeNull();
      expect(claimed?.leaseExpiresAt).toBe(25_000);

      // Heartbeat at 23_000 with 5_000 extension
      const ok = queue.heartbeatLease("heartbeat-acct", claimed!.leaseId, 5_000, 23_000);
      expect(ok).toBe(true);

      const job = queue.getJob(claimed!.jobId);
      expect(job?.lease_expires_at).toBe(30_000);

      queue.close();
    });
  });

  describe("4. Rate limit (429) handling", () => {
    it("applies exponential cooldown on 429 and disables account after exceeding max consecutive errors", async () => {
      const queue = new DurableReviewQueue(":memory:");

      queue.enqueueJob({
        repo: "test/repo",
        itemType: "pr",
        itemNumber: 1,
        title: "Rate Limit Test",
        priorityBand: "P1_HIGH",
        priorityScore: 80,
        inputFingerprint: "fp-429",
        promptSchemaVersion: "v1",
        payload: {},
      });

      let callCount = 0;
      const scheduler = new MultiProviderReviewScheduler(
        queue,
        [
          {
            accountId: "rate-limited-acct",
            provider: "featherless",
            model: "zai-org/GLM-5.3-Flash",
            apiKey: "key-429-secret",
          },
        ],
        {
          cooldownBaseMs: 20,
          maxConsecutive429: 2,
          pollIntervalMs: 5,
          workerFn: async () => {
            callCount++;
            const err = new Error("Rate limit exceeded — try again later");
            (err as any).statusCode = 429;
            throw err;
          },
        },
      );

      const result = await scheduler.start();

      // Expect callCount to be 3 (call 1: streak 1, call 2: streak 2, call 3: streak 3 > 2 -> disabled)
      expect(callCount).toBe(3);
      expect(result.disabledAccounts).toContain("rate-limited-acct");
      expect(scheduler.isAccountDisabled("rate-limited-acct")).toBe(true);

      queue.close();
    });
  });

  describe("5. Account 403 upgrade_required / 402 credit_exhausted", () => {
    it("immediately disables account on 403 upgrade_required without loop while active accounts finish queue", async () => {
      const queue = new DurableReviewQueue(":memory:");

      queue.enqueueJob({
        repo: "test/repo",
        itemType: "pr",
        itemNumber: 1,
        title: "PR 1",
        priorityBand: "P0_CRITICAL",
        priorityScore: 95,
        inputFingerprint: "fp-job-1",
        promptSchemaVersion: "v1",
        payload: {},
      });
      queue.enqueueJob({
        repo: "test/repo",
        itemType: "pr",
        itemNumber: 2,
        title: "PR 2",
        priorityBand: "P1_HIGH",
        priorityScore: 85,
        inputFingerprint: "fp-job-2",
        promptSchemaVersion: "v1",
        payload: {},
      });

      let failingAcctCalls = 0;
      const scheduler = new MultiProviderReviewScheduler(
        queue,
        [
          {
            accountId: "failing-upgrade-acct",
            provider: "featherless",
            model: "zai-org/GLM-5.3-Flash",
            apiKey: "key-bad-quota",
          },
          {
            accountId: "healthy-acct",
            provider: "featherless",
            model: "zai-org/GLM-5.3-Flash",
            apiKey: "key-good-paid",
          },
        ],
        {
          pollIntervalMs: 5,
          workerFn: async (_job, profile) => {
            if (profile.accountId === "failing-upgrade-acct") {
              failingAcctCalls++;
              const err = new Error("HTTP 403 Forbidden: upgrade_required for model tier");
              (err as any).statusCode = 403;
              throw err;
            }
            return {
              result: { recommendation: "merge" },
              promptTokens: 20,
              completionTokens: 30,
            };
          },
        },
      );

      const result = await scheduler.start();

      // The failing account must be disabled IMMEDIATELY on first 403 upgrade_required without looping!
      expect(failingAcctCalls).toBe(1);
      expect(result.disabledAccounts).toContain("failing-upgrade-acct");
      expect(scheduler.isAccountDisabled("failing-upgrade-acct")).toBe(true);

      // Remaining healthy account completed both jobs
      expect(result.completedJobs).toBe(2);
      expect(queue.getJob("test/repo:pr:1")?.status).toBe("completed");
      expect(queue.getJob("test/repo:pr:2")?.status).toBe("completed");

      queue.close();
    });

    it("immediately disables account on 402 credit_exhausted", async () => {
      const queue = new DurableReviewQueue(":memory:");

      queue.enqueueJob({
        repo: "test/repo",
        itemType: "pr",
        itemNumber: 1,
        title: "PR 1",
        priorityBand: "P1_HIGH",
        priorityScore: 80,
        inputFingerprint: "fp-job-credit",
        promptSchemaVersion: "v1",
        payload: {},
      });

      let calls = 0;
      const scheduler = new MultiProviderReviewScheduler(
        queue,
        [
          {
            accountId: "out-of-credits",
            provider: "featherless",
            model: "zai-org/GLM-5.3-Flash",
            apiKey: "key-no-money",
          },
        ],
        {
          pollIntervalMs: 5,
          workerFn: async () => {
            calls++;
            const err = new Error("Payment required: credit_exhausted balance is 0.00");
            (err as any).statusCode = 402;
            throw err;
          },
        },
      );

      const result = await scheduler.start();

      expect(calls).toBe(1);
      expect(result.disabledAccounts).toContain("out-of-credits");
      expect(scheduler.isAccountDisabled("out-of-credits")).toBe(true);
      expect(result.completedJobs).toBe(0);

      queue.close();
    });
  });

  describe("6. No account cycling on rejected requests (400 / 422)", () => {
    it("marks job rejected_permanent and NEVER retries on other accounts", async () => {
      const queue = new DurableReviewQueue(":memory:");

      // Enqueue 1 invalid job and 1 valid job
      queue.enqueueJob({
        repo: "invalid/schema-repo",
        itemType: "pr",
        itemNumber: 666,
        title: "Malformed Prompt Request",
        priorityBand: "P0_CRITICAL",
        priorityScore: 99,
        inputFingerprint: "fp-rejected-request",
        promptSchemaVersion: "v1",
        payload: { malformed: true },
      });

      queue.enqueueJob({
        repo: "valid/normal-repo",
        itemType: "pr",
        itemNumber: 777,
        title: "Normal Valid PR",
        priorityBand: "P1_HIGH",
        priorityScore: 80,
        inputFingerprint: "fp-valid-request",
        promptSchemaVersion: "v1",
        payload: { normal: true },
      });

      const executionsByJobId: Record<string, string[]> = {
        "invalid/schema-repo:pr:666": [],
        "valid/normal-repo:pr:777": [],
      };

      const scheduler = new MultiProviderReviewScheduler(
        queue,
        [
          { accountId: "acct-1", provider: "featherless", model: "m", apiKey: "k1" },
          { accountId: "acct-2", provider: "featherless", model: "m", apiKey: "k2" },
          { accountId: "acct-3", provider: "featherless", model: "m", apiKey: "k3" },
        ],
        {
          pollIntervalMs: 5,
          workerFn: async (job, profile) => {
            executionsByJobId[job.jobId].push(profile.accountId);

            if (job.jobId === "invalid/schema-repo:pr:666") {
              const err = new Error("HTTP 400 Bad Request: prompt schema validation failed");
              (err as any).statusCode = 400;
              throw err;
            }

            return {
              result: { recommendation: "merge" },
              promptTokens: 10,
              completionTokens: 20,
            };
          },
        },
      );

      const result = await scheduler.start();

      // Check job 666 status
      const rejectedJob = queue.getJob("invalid/schema-repo:pr:666");
      expect(rejectedJob?.status).toBe("rejected_permanent");
      expect(rejectedJob?.last_error_code).toBe("REQUEST_REJECTED");

      // CRITICAL ASSERTION: Job 666 was attempted EXACTLY ONCE!
      // It was NEVER retried on acct-2 or acct-3!
      expect(executionsByJobId["invalid/schema-repo:pr:666"].length).toBe(1);

      // Accounts are NOT disabled (bad input is not an account credential issue)
      expect(scheduler.isAccountDisabled("acct-1")).toBe(false);
      expect(scheduler.isAccountDisabled("acct-2")).toBe(false);
      expect(scheduler.isAccountDisabled("acct-3")).toBe(false);

      // Job 777 completed cleanly
      expect(queue.getJob("valid/normal-repo:pr:777")?.status).toBe("completed");
      expect(result.rejectedJobs).toBe(1);
      expect(result.completedJobs).toBe(1);

      queue.close();
    });
  });

  describe("7. Rejects > 5 account profiles", () => {
    it("rejects configuration when more than 5 profiles are provided", () => {
      const queue = new DurableReviewQueue(":memory:");

      const sixProfiles: ReviewAccountProfile[] = [1, 2, 3, 4, 5, 6].map((i) => ({
        accountId: `acct-${i}`,
        provider: "featherless",
        model: "zai-org/GLM-5.3-Flash",
        apiKey: `key-${i}`,
      }));

      expect(() => new MultiProviderReviewScheduler(queue, sixProfiles)).toThrow(
        /Exceeded maximum allowed provider accounts \(5\)/,
      );

      expect(() =>
        loadMultiAccountProfilesFromEnv({
          REVIEW_ACCOUNT_1_KEY: "k1",
          REVIEW_ACCOUNT_2_KEY: "k2",
          REVIEW_ACCOUNT_3_KEY: "k3",
          REVIEW_ACCOUNT_4_KEY: "k4",
          REVIEW_ACCOUNT_5_KEY: "k5",
          REVIEW_ACCOUNT_6_KEY: "k6",
        }),
      ).toThrow(/exceeds maximum allowed provider accounts \(5\)/);

      expect(() =>
        loadMultiAccountProfilesFromEnv({
          FEATHERLESS_API_KEY_1: "k1",
          FEATHERLESS_API_KEY_2: "k2",
          FEATHERLESS_API_KEY_3: "k3",
          FEATHERLESS_API_KEY_4: "k4",
          FEATHERLESS_API_KEY_5: "k5",
          FEATHERLESS_API_KEY_6: "k6",
        }),
      ).toThrow(/exceeds maximum allowed provider accounts \(5\)/);

      queue.close();
    });
  });

  describe("8. Credential resolution & fingerprint provenance", () => {
    it("computes 12-char SHA-256 fingerprint without revealing raw key", () => {
      const cred = resolveAccountCredential({
        accountId: "acct-fp-test",
        provider: "featherless",
        model: "m",
        apiKey: "  secret-key-to-fingerprint  ",
      });

      expect(cred).not.toBeNull();
      expect(cred?.apiKey).toBe("secret-key-to-fingerprint");
      expect(cred?.keyFingerprint).toHaveLength(12);
      expect(/^[0-9a-f]{12}$/.test(cred!.keyFingerprint)).toBe(true);
    });

    it("resolves credentials from process.env apiKeyEnvVar", () => {
      process.env.TEST_CUSTOM_API_KEY_VAR = "my-env-secret-key";
      try {
        const cred = resolveAccountCredential({
          accountId: "acct-env-test",
          provider: "openai",
          model: "gpt-4o-mini",
          apiKeyEnvVar: "TEST_CUSTOM_API_KEY_VAR",
        });

        expect(cred).not.toBeNull();
        expect(cred?.keyFingerprint).toHaveLength(12);
      } finally {
        delete process.env.TEST_CUSTOM_API_KEY_VAR;
      }
    });
  });

  describe("9. Pre-flight authentication verification", () => {
    it("verifies accounts independently and generates comprehensive preflight report", async () => {
      const profiles: ReviewAccountProfile[] = [
        {
          accountId: "acct-auth-ok",
          provider: "featherless",
          model: "zai-org/GLM-5.3-Flash",
          apiKey: "valid-key-1",
        },
        {
          accountId: "acct-auth-fail",
          provider: "featherless",
          model: "zai-org/GLM-5.3-Flash",
          apiKey: "invalid-key-2",
        },
      ];

      const report = await verifyAccountsIndependently(profiles, async (prof) => {
        if (prof.accountId === "acct-auth-fail") {
          return {
            ok: false,
            status: "auth_failed",
            httpStatus: 401,
            errorCode: "AUTH_FAILED",
            errorMessage: "Invalid API Key",
          };
        }
        return {
          ok: true,
          status: "authenticated",
          httpStatus: 200,
        };
      });

      expect(report.totalAccountCount).toBe(2);
      expect(report.activeAccountCount).toBe(1);
      expect(report.allAuthenticated).toBe(false);
      expect(report.accounts[0].ok).toBe(true);
      expect(report.accounts[0].status).toBe("authenticated");
      expect(report.accounts[1].ok).toBe(false);
      expect(report.accounts[1].status).toBe("auth_failed");
    });
  });

  describe("10. Usage ledger and queue statistics", () => {
    it("aggregates usage ledger and queue counts properly", () => {
      const queue = new DurableReviewQueue(":memory:");

      queue.enqueueJob({
        repo: "test/repo",
        itemType: "pr",
        itemNumber: 1,
        title: "PR 1",
        priorityBand: "P1_HIGH",
        priorityScore: 80,
        inputFingerprint: "fp-1",
        promptSchemaVersion: "v1",
        payload: {},
      });

      const claimed = queue.claimNextJobForAccount("ledger-acct", 10_000, 1000);
      expect(claimed).not.toBeNull();

      queue.completeJobWithCheckpoint({
        jobId: claimed!.jobId,
        accountId: "ledger-acct",
        leaseId: claimed!.leaseId,
        provider: "featherless",
        model: "m",
        keyFingerprint: "fingerprint12",
        result: { ok: true },
        promptTokens: 100,
        completionTokens: 50,
        latencyMs: 250,
      });

      const summary = queue.getUsageSummaryByAccount();
      expect(summary["ledger-acct"]).toBeDefined();
      expect(summary["ledger-acct"].totalRequests).toBe(1);
      expect(summary["ledger-acct"].successCount).toBe(1);
      expect(summary["ledger-acct"].promptTokens).toBe(100);
      expect(summary["ledger-acct"].completionTokens).toBe(50);

      const stats = queue.getQueueStats();
      expect(stats.completed).toBe(1);
      expect(stats.queued).toBe(0);
      expect(stats.total).toBe(1);

      queue.close();
    });
  });
});
