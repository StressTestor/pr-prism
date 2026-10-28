import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type ReviewJobStatus = "queued" | "claimed" | "completed" | "failed" | "rejected_permanent" | "invalid";
export type ReviewPriorityBand = "P0_CRITICAL" | "P1_HIGH" | "P2_MODERATE" | "P3_ROUTINE_LOCAL";
export type ReviewItemType = "pr" | "issue";
export type LedgerStatus =
  | "success"
  | "rate_limited"
  | "auth_failed"
  | "credit_exhausted"
  | "request_rejected"
  | "transient_error";

export interface EnqueueReviewJobInput {
  repo: string;
  itemType: ReviewItemType;
  itemNumber: number;
  title: string;
  priorityBand: ReviewPriorityBand;
  priorityScore: number;
  inputFingerprint: string;
  promptSchemaVersion: string;
  payload: Record<string, unknown> | string;
  maxAttempts?: number;
  jobId?: string;
}

export interface ClaimedReviewJob {
  jobId: string;
  repo: string;
  itemType: ReviewItemType;
  itemNumber: number;
  title: string;
  priorityBand: ReviewPriorityBand;
  priorityScore: number;
  inputFingerprint: string;
  promptSchemaVersion: string;
  payload: any;
  leaseId: string;
  leaseExpiresAt: number;
  attempts: number;
  maxAttempts: number;
  accountId: string;
}

export interface CompleteReviewJobParams {
  jobId: string;
  accountId: string;
  leaseId: string;
  provider: string;
  model: string;
  keyFingerprint: string;
  result: unknown;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  nowMs?: number;
  /** Actual finish_reason from the model API response (e.g. "stop", "length") */
  finish_reason?: string | null;
  /** The model ID as reported by the API (may differ from the configured model) */
  recorded_model_id?: string | null;
  /** SHA-256 prefix of the result JSON for deduplication and provenance */
  response_fingerprint?: string | null;
  /** SHA-256 prefix of the prompt sent to the model */
  prompt_fingerprint?: string | null;
  /** Completeness assessment of the evidence provided to the model */
  evidence_completeness?: "full" | "partial" | "minimal" | null;
  /** If true, record the job status as "invalid" instead of "completed" */
  markInvalid?: boolean;
}

export interface ReleaseReviewJobFailureParams {
  jobId: string;
  accountId: string;
  leaseId: string;
  provider: string;
  model: string;
  keyFingerprint: string;
  failureKind: "request_rejected" | "auth_failed" | "credit_exhausted" | "rate_limited" | "transient_error";
  errorMessage?: string;
  errorCode?: string;
  httpStatus?: number;
  latencyMs?: number;
  nowMs?: number;
}

export interface ReviewJobRecord {
  job_id: string;
  repo: string;
  item_type: ReviewItemType;
  item_number: number;
  title: string;
  priority_band: ReviewPriorityBand;
  priority_score: number;
  input_fingerprint: string;
  prompt_schema_version: string;
  payload_json: string;
  status: ReviewJobStatus;
  claimed_by_account: string | null;
  lease_id: string | null;
  lease_expires_at: number | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  last_error_code: string | null;
  failed_accounts_json: string;
  created_at: string;
  updated_at: string;
}

export interface ReviewCheckpointRecord {
  checkpoint_key: string;
  job_id: string;
  repo: string;
  item_type: ReviewItemType;
  item_number: number;
  input_fingerprint: string;
  prompt_schema_version: string;
  account_id: string;
  provider: string;
  model: string;
  result_json: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  completed_at: string;
  /** Status of the checkpoint: "completed" (valid) or "invalid" (failed validation) */
  checkpoint_status: string | null;
  /** Finish reason from the model API (e.g. "stop", "length") */
  finish_reason: string | null;
  /** Model ID as reported by the API */
  recorded_model_id: string | null;
  /** SHA-256 prefix of the result JSON */
  response_fingerprint: string | null;
  /** SHA-256 prefix of the prompt sent */
  prompt_fingerprint: string | null;
  /** Completeness of evidence provided to the model */
  evidence_completeness: string | null;
}

export interface AccountUsageLedgerRecord {
  id: number;
  account_id: string;
  key_fingerprint: string;
  provider: string;
  model: string;
  job_id: string | null;
  status: LedgerStatus;
  http_status: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  error_message: string | null;
  recorded_at: string;
}

export interface QueueStats {
  queued: number;
  claimed: number;
  completed: number;
  failed: number;
  rejected_permanent: number;
  invalid: number;
  total: number;
}

export interface AccountUsageSummary {
  accountId: string;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  promptTokens: number;
  completionTokens: number;
  lastSeen: string;
}

/**
 * Durable Review Queue backed by SQLite with WAL mode.
 *
 * Implements strict per-account single lease concurrency invariants,
 * idempotent checkpoint reuse, exponential backoff accounting,
 * and permanent rejection isolation for invalid requests.
 */
export class DurableReviewQueue {
  private db: Database.Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_jobs (
        job_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        priority_band TEXT NOT NULL,
        priority_score REAL NOT NULL,
        input_fingerprint TEXT NOT NULL,
        prompt_schema_version TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_by_account TEXT,
        lease_id TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        last_error_code TEXT,
        failed_accounts_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_jobs_status_priority
        ON review_jobs(status, priority_score DESC, item_number ASC);

      CREATE INDEX IF NOT EXISTS idx_review_jobs_lease_expires
        ON review_jobs(status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS account_leases (
        account_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        lease_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_account_leases_expires
        ON account_leases(expires_at);

      CREATE TABLE IF NOT EXISTS review_checkpoints (
        checkpoint_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_number INTEGER NOT NULL,
        input_fingerprint TEXT NOT NULL,
        prompt_schema_version TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        result_json TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        latency_ms INTEGER,
        completed_at TEXT NOT NULL,
        checkpoint_status TEXT,
        finish_reason TEXT,
        recorded_model_id TEXT,
        response_fingerprint TEXT,
        prompt_fingerprint TEXT,
        evidence_completeness TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_review_checkpoints_lookup
        ON review_checkpoints(repo, item_type, item_number, input_fingerprint, prompt_schema_version);

      CREATE TABLE IF NOT EXISTS account_usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        job_id TEXT,
        status TEXT NOT NULL,
        http_status INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_account_usage_ledger_account
        ON account_usage_ledger(account_id, recorded_at);
    `);

    // Migration guard: ensure columns exist if opening an older database
    const checkpointCols = new Set(
      (this.db.pragma("table_info(review_checkpoints)") as Array<{ name: string }>).map((c) => c.name),
    );
    const newCheckpointCols: Array<[string, string]> = [
      ["checkpoint_status", "TEXT"],
      ["finish_reason", "TEXT"],
      ["recorded_model_id", "TEXT"],
      ["response_fingerprint", "TEXT"],
      ["prompt_fingerprint", "TEXT"],
      ["evidence_completeness", "TEXT"],
    ];
    for (const [col, colType] of newCheckpointCols) {
      if (!checkpointCols.has(col)) {
        this.db.exec(`ALTER TABLE review_checkpoints ADD COLUMN ${col} ${colType}`);
      }
    }
  }

  private runImmediate<T>(fn: () => T): T {
    if (this.db.inTransaction) {
      return fn();
    }
    return this.db.transaction(fn).immediate();
  }

  /**
   * Enqueue a review job.
   * If a valid checkpoint already exists for (repo, itemType, itemNumber, inputFingerprint, promptSchemaVersion),
   * the job is inserted/updated as 'completed' and returns checkpointReused: true.
   */
  public enqueueJob(job: EnqueueReviewJobInput): { jobId: string; status: string; checkpointReused: boolean } {
    return this.runImmediate(() => {
      const jobId = job.jobId || `${job.repo}:${job.itemType}:${job.itemNumber}`;
      const checkpointKey = `${job.repo}:${job.itemType}:${job.itemNumber}:${job.inputFingerprint}:${job.promptSchemaVersion}`;
      const now = Date.now();
      const isoNow = new Date(now).toISOString();
      const payloadJson = typeof job.payload === "string" ? job.payload : JSON.stringify(job.payload);
      const maxAttempts = job.maxAttempts ?? 3;

      const existingCheckpoint = this.db
        .prepare("SELECT * FROM review_checkpoints WHERE checkpoint_key = ?")
        .get(checkpointKey) as ReviewCheckpointRecord | undefined;

      const isCheckpointValid = Boolean(
        existingCheckpoint &&
          existingCheckpoint.checkpoint_status !== "invalid" &&
          existingCheckpoint.result_json &&
          existingCheckpoint.result_json !== "{}" &&
          !existingCheckpoint.result_json.includes('"rawContent":'),
      );

      if (isCheckpointValid) {
        const existingJob = this.db.prepare("SELECT * FROM review_jobs WHERE job_id = ?").get(jobId) as
          | ReviewJobRecord
          | undefined;

        if (existingJob) {
          this.db
            .prepare(`
              UPDATE review_jobs
              SET repo = ?, item_type = ?, item_number = ?, title = ?, priority_band = ?, priority_score = ?,
                  input_fingerprint = ?, prompt_schema_version = ?, payload_json = ?, status = 'completed',
                  claimed_by_account = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE job_id = ?
            `)
            .run(
              job.repo,
              job.itemType,
              job.itemNumber,
              job.title,
              job.priorityBand,
              job.priorityScore,
              job.inputFingerprint,
              job.promptSchemaVersion,
              payloadJson,
              isoNow,
              jobId,
            );
        } else {
          this.db
            .prepare(`
              INSERT INTO review_jobs (
                job_id, repo, item_type, item_number, title, priority_band, priority_score,
                input_fingerprint, prompt_schema_version, payload_json, status,
                claimed_by_account, lease_id, lease_expires_at, attempts, max_attempts,
                last_error, last_error_code, failed_accounts_json, created_at, updated_at
              ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, 'completed',
                NULL, NULL, NULL, 0, ?,
                NULL, NULL, '[]', ?, ?
              )
            `)
            .run(
              jobId,
              job.repo,
              job.itemType,
              job.itemNumber,
              job.title,
              job.priorityBand,
              job.priorityScore,
              job.inputFingerprint,
              job.promptSchemaVersion,
              payloadJson,
              maxAttempts,
              isoNow,
              isoNow,
            );
        }
        return { jobId, status: "completed", checkpointReused: true };
      }

      const existingJob = this.db.prepare("SELECT * FROM review_jobs WHERE job_id = ?").get(jobId) as
        | ReviewJobRecord
        | undefined;

      if (!existingJob) {
        this.db
          .prepare(`
            INSERT INTO review_jobs (
              job_id, repo, item_type, item_number, title, priority_band, priority_score,
              input_fingerprint, prompt_schema_version, payload_json, status,
              claimed_by_account, lease_id, lease_expires_at, attempts, max_attempts,
              last_error, last_error_code, failed_accounts_json, created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, 'queued',
              NULL, NULL, NULL, 0, ?,
              NULL, NULL, '[]', ?, ?
            )
          `)
          .run(
            jobId,
            job.repo,
            job.itemType,
            job.itemNumber,
            job.title,
            job.priorityBand,
            job.priorityScore,
            job.inputFingerprint,
            job.promptSchemaVersion,
            payloadJson,
            maxAttempts,
            isoNow,
            isoNow,
          );
        return { jobId, status: "queued", checkpointReused: false };
      }

      if (existingJob.status === "claimed") {
        return { jobId, status: "claimed", checkpointReused: false };
      }

      if (
        existingJob.status === "completed" &&
        existingJob.input_fingerprint === job.inputFingerprint &&
        existingJob.prompt_schema_version === job.promptSchemaVersion
      ) {
        return { jobId, status: "completed", checkpointReused: true };
      }

      this.db
        .prepare(`
          UPDATE review_jobs
          SET repo = ?, item_type = ?, item_number = ?, title = ?, priority_band = ?, priority_score = ?,
              input_fingerprint = ?, prompt_schema_version = ?, payload_json = ?, status = 'queued',
              claimed_by_account = NULL, lease_id = NULL, lease_expires_at = NULL,
              attempts = 0, max_attempts = ?, last_error = NULL, last_error_code = NULL,
              failed_accounts_json = '[]', updated_at = ?
          WHERE job_id = ?
        `)
        .run(
          job.repo,
          job.itemType,
          job.itemNumber,
          job.title,
          job.priorityBand,
          job.priorityScore,
          job.inputFingerprint,
          job.promptSchemaVersion,
          payloadJson,
          maxAttempts,
          isoNow,
          jobId,
        );

      return { jobId, status: "queued", checkpointReused: false };
    });
  }

  /**
   * Atomically claim the next highest-priority job for a given account.
   *
   * Enforces the hard concurrency invariant:
   * First verifies the account holds NO active unexpired lease.
   * If an active lease exists, returns null.
   */
  public claimNextJobForAccount(
    accountId: string,
    leaseDurationMs: number = 60_000,
    nowMs: number = Date.now(),
  ): ClaimedReviewJob | null {
    return this.runImmediate(() => {
      // Clean expired leases first
      this.recoverExpiredLeases(nowMs);

      // Hard concurrency invariant: verify account has 0 active leases
      const existingLease = this.db.prepare("SELECT * FROM account_leases WHERE account_id = ?").get(accountId) as
        | { expires_at: number }
        | undefined;

      if (existingLease && existingLease.expires_at > nowMs) {
        return null;
      }

      // Fetch candidates ordered by priority_score DESC, item_number ASC
      const candidates = this.db
        .prepare(`
          SELECT * FROM review_jobs
          WHERE status = 'queued' AND attempts < max_attempts
          ORDER BY priority_score DESC, item_number ASC
        `)
        .all() as ReviewJobRecord[];

      for (const candidate of candidates) {
        const checkpointKey = `${candidate.repo}:${candidate.item_type}:${candidate.item_number}:${candidate.input_fingerprint}:${candidate.prompt_schema_version}`;
        const cp = this.db.prepare("SELECT * FROM review_checkpoints WHERE checkpoint_key = ?").get(checkpointKey) as
          | ReviewCheckpointRecord
          | undefined;

        if (cp) {
          const isCpValid =
            cp.checkpoint_status !== "invalid" &&
            cp.result_json &&
            cp.result_json !== "{}" &&
            !cp.result_json.includes('"rawContent":');

          if (isCpValid) {
            const isoNow = new Date(nowMs).toISOString();
            this.db
              .prepare("UPDATE review_jobs SET status = 'completed', updated_at = ? WHERE job_id = ?")
              .run(isoNow, candidate.job_id);
            continue;
          }
        }

        // Claim candidate atomically
        const leaseId = randomUUID();
        const leaseExpiresAt = nowMs + leaseDurationMs;
        const isoNow = new Date(nowMs).toISOString();

        this.db
          .prepare(`
            INSERT INTO account_leases (account_id, job_id, lease_id, acquired_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
          `)
          .run(accountId, candidate.job_id, leaseId, nowMs, leaseExpiresAt);

        this.db
          .prepare(`
            UPDATE review_jobs
            SET status = 'claimed',
                claimed_by_account = ?,
                lease_id = ?,
                lease_expires_at = ?,
                attempts = attempts + 1,
                updated_at = ?
            WHERE job_id = ?
          `)
          .run(accountId, leaseId, leaseExpiresAt, isoNow, candidate.job_id);

        let parsedPayload: any = candidate.payload_json;
        try {
          parsedPayload = JSON.parse(candidate.payload_json);
        } catch {
          // preserve raw string if not json
        }

        const claimedJob: ClaimedReviewJob = {
          jobId: candidate.job_id,
          repo: candidate.repo,
          itemType: candidate.item_type,
          itemNumber: candidate.item_number,
          title: candidate.title,
          priorityBand: candidate.priority_band,
          priorityScore: candidate.priority_score,
          inputFingerprint: candidate.input_fingerprint,
          promptSchemaVersion: candidate.prompt_schema_version,
          payload: parsedPayload,
          leaseId,
          leaseExpiresAt,
          attempts: candidate.attempts + 1,
          maxAttempts: candidate.max_attempts,
          accountId,
        };

        return claimedJob;
      }

      return null;
    });
  }

  /**
   * Heartbeat an active lease, extending its expiration time.
   */
  public heartbeatLease(accountId: string, leaseId: string, extensionMs: number, nowMs: number = Date.now()): boolean {
    return this.runImmediate(() => {
      const lease = this.db
        .prepare("SELECT * FROM account_leases WHERE account_id = ? AND lease_id = ?")
        .get(accountId, leaseId) as { expires_at: number } | undefined;

      if (!lease || lease.expires_at <= nowMs) {
        return false;
      }

      const newExpiresAt = Math.max(lease.expires_at, nowMs) + extensionMs;

      this.db
        .prepare("UPDATE account_leases SET expires_at = ? WHERE account_id = ? AND lease_id = ?")
        .run(newExpiresAt, accountId, leaseId);

      this.db
        .prepare("UPDATE review_jobs SET lease_expires_at = ? WHERE claimed_by_account = ? AND lease_id = ?")
        .run(newExpiresAt, accountId, leaseId);

      return true;
    });
  }

  /**
   * Recover all expired leases.
   * If a job was claimed and its lease expired:
   *   - If attempts < max_attempts: resets status to 'queued'
   *   - If attempts >= max_attempts: marks status as 'failed'
   */
  public recoverExpiredLeases(nowMs: number = Date.now()): number {
    return this.runImmediate(() => {
      let recovered = 0;
      const isoNow = new Date(nowMs).toISOString();

      const expiredLeases = this.db.prepare("SELECT * FROM account_leases WHERE expires_at <= ?").all(nowMs) as Array<{
        account_id: string;
        job_id: string;
        lease_id: string;
      }>;

      for (const lease of expiredLeases) {
        this.db.prepare("DELETE FROM account_leases WHERE account_id = ?").run(lease.account_id);
        const job = this.db.prepare("SELECT * FROM review_jobs WHERE job_id = ?").get(lease.job_id) as
          | ReviewJobRecord
          | undefined;

        if (job && job.status === "claimed") {
          recovered++;
          if (job.attempts < job.max_attempts) {
            this.db
              .prepare(`
                UPDATE review_jobs
                SET status = 'queued', claimed_by_account = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE job_id = ?
              `)
              .run(isoNow, job.job_id);
          } else {
            this.db
              .prepare(`
                UPDATE review_jobs
                SET status = 'failed', last_error = 'Lease expired after max attempts', last_error_code = 'LEASE_EXPIRED',
                    claimed_by_account = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE job_id = ?
              `)
              .run(isoNow, job.job_id);
          }
        }
      }

      const orphanClaimed = this.db
        .prepare(
          "SELECT * FROM review_jobs WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
        )
        .all(nowMs) as ReviewJobRecord[];

      for (const job of orphanClaimed) {
        recovered++;
        this.db.prepare("DELETE FROM account_leases WHERE job_id = ?").run(job.job_id);
        if (job.attempts < job.max_attempts) {
          this.db
            .prepare(`
              UPDATE review_jobs
              SET status = 'queued', claimed_by_account = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE job_id = ?
            `)
            .run(isoNow, job.job_id);
        } else {
          this.db
            .prepare(`
              UPDATE review_jobs
              SET status = 'failed', last_error = 'Lease expired after max attempts', last_error_code = 'LEASE_EXPIRED',
                  claimed_by_account = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE job_id = ?
            `)
            .run(isoNow, job.job_id);
        }
      }

      return recovered;
    });
  }

  /**
   * Complete a claimed job with a review checkpoint.
   * Atomically records the checkpoint, completes the job, releases the lease,
   * and logs success into the usage ledger.
   *
   * If `params.markInvalid` is true, the job status is set to "invalid" instead
   * of "completed" — used for jobs where the HTTP call succeeded but the result
   * failed post-hoc validation.
   */
  public completeJobWithCheckpoint(params: CompleteReviewJobParams): void {
    this.runImmediate(() => {
      const now = params.nowMs ?? Date.now();
      const isoNow = new Date(now).toISOString();

      const job = this.db.prepare("SELECT * FROM review_jobs WHERE job_id = ?").get(params.jobId) as
        | ReviewJobRecord
        | undefined;

      if (!job) {
        throw new Error(`Job ${params.jobId} not found`);
      }

      const checkpointKey = `${job.repo}:${job.item_type}:${job.item_number}:${job.input_fingerprint}:${job.prompt_schema_version}`;
      const resultJson = typeof params.result === "string" ? params.result : JSON.stringify(params.result);
      const finalJobStatus = params.markInvalid ? "invalid" : "completed";
      const checkpointStatus = params.markInvalid ? "invalid" : "completed";

      this.db
        .prepare(`
          INSERT OR REPLACE INTO review_checkpoints (
            checkpoint_key, job_id, repo, item_type, item_number, input_fingerprint,
            prompt_schema_version, account_id, provider, model, result_json,
            prompt_tokens, completion_tokens, latency_ms, completed_at,
            checkpoint_status, finish_reason, recorded_model_id, response_fingerprint,
            prompt_fingerprint, evidence_completeness
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          checkpointKey,
          job.job_id,
          job.repo,
          job.item_type,
          job.item_number,
          job.input_fingerprint,
          job.prompt_schema_version,
          params.accountId,
          params.provider,
          params.model,
          resultJson,
          params.promptTokens ?? null,
          params.completionTokens ?? null,
          params.latencyMs ?? null,
          isoNow,
          checkpointStatus,
          params.finish_reason ?? null,
          params.recorded_model_id ?? null,
          params.response_fingerprint ?? null,
          params.prompt_fingerprint ?? null,
          params.evidence_completeness ?? null,
        );

      this.db
        .prepare(`
          UPDATE review_jobs
          SET status = ?, claimed_by_account = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ?
        `)
        .run(finalJobStatus, isoNow, job.job_id);

      this.db.prepare("DELETE FROM account_leases WHERE account_id = ?").run(params.accountId);

      this.db
        .prepare(`
          INSERT INTO account_usage_ledger (
            account_id, key_fingerprint, provider, model, job_id, status, http_status,
            prompt_tokens, completion_tokens, latency_ms, error_message, recorded_at
          ) VALUES (?, ?, ?, ?, ?, 'success', 200, ?, ?, ?, NULL, ?)
        `)
        .run(
          params.accountId,
          params.keyFingerprint,
          params.provider,
          params.model,
          job.job_id,
          params.promptTokens ?? 0,
          params.completionTokens ?? 0,
          params.latencyMs ?? 0,
          isoNow,
        );
    });
  }

  /**
   * Release a claimed job upon failure.
   *
   * Crucial rule: Never cycle accounts to bypass a rejected request!
   * - If failureKind === 'request_rejected', immediately set status = 'rejected_permanent'
   * - If failureKind === 'auth_failed' or 'credit_exhausted', decrement attempts and reset to 'queued'
   * - If failureKind === 'rate_limited' or 'transient_error', reset to 'queued' (or 'failed' if attempts >= max_attempts)
   */
  public releaseJobOnFailure(params: ReleaseReviewJobFailureParams): void {
    this.runImmediate(() => {
      const now = params.nowMs ?? Date.now();
      const isoNow = new Date(now).toISOString();

      const job = this.db.prepare("SELECT * FROM review_jobs WHERE job_id = ?").get(params.jobId) as
        | ReviewJobRecord
        | undefined;

      if (!job) {
        throw new Error(`Job ${params.jobId} not found`);
      }

      this.db.prepare("DELETE FROM account_leases WHERE account_id = ?").run(params.accountId);

      let failedAccounts: string[] = [];
      try {
        failedAccounts = JSON.parse(job.failed_accounts_json || "[]");
      } catch {
        failedAccounts = [];
      }
      if (!failedAccounts.includes(params.accountId)) {
        failedAccounts.push(params.accountId);
      }
      const failedAccountsJson = JSON.stringify(failedAccounts);

      let newStatus: ReviewJobStatus;
      let newAttempts = job.attempts;
      const errorCode = params.errorCode || params.failureKind.toUpperCase();
      const errorMessage = params.errorMessage || params.failureKind;

      if (params.failureKind === "request_rejected") {
        newStatus = "rejected_permanent";
      } else if (params.failureKind === "auth_failed" || params.failureKind === "credit_exhausted") {
        newAttempts = Math.max(0, job.attempts - 1);
        newStatus = "queued";
      } else {
        if (job.attempts >= job.max_attempts) {
          newStatus = "failed";
        } else {
          newStatus = "queued";
        }
      }

      this.db
        .prepare(`
          UPDATE review_jobs
          SET status = ?, attempts = ?, last_error = ?, last_error_code = ?,
              failed_accounts_json = ?, claimed_by_account = NULL, lease_id = NULL,
              lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ?
        `)
        .run(newStatus, newAttempts, errorMessage, errorCode, failedAccountsJson, isoNow, job.job_id);

      this.db
        .prepare(`
          INSERT INTO account_usage_ledger (
            account_id, key_fingerprint, provider, model, job_id, status, http_status,
            prompt_tokens, completion_tokens, latency_ms, error_message, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
        `)
        .run(
          params.accountId,
          params.keyFingerprint,
          params.provider,
          params.model,
          job.job_id,
          params.failureKind,
          params.httpStatus ?? null,
          params.latencyMs ?? 0,
          errorMessage,
          isoNow,
        );
    });
  }

  /**
   * Retrieve a checkpoint by key or by composite fields.
   */
  public getCheckpoint(
    repoOrKey: string,
    itemType?: ReviewItemType,
    itemNumber?: number,
    inputFingerprint?: string,
    promptSchemaVersion?: string,
  ): ReviewCheckpointRecord | null {
    const checkpointKey =
      itemType !== undefined &&
      itemNumber !== undefined &&
      inputFingerprint !== undefined &&
      promptSchemaVersion !== undefined
        ? `${repoOrKey}:${itemType}:${itemNumber}:${inputFingerprint}:${promptSchemaVersion}`
        : repoOrKey;

    const row = this.db.prepare("SELECT * FROM review_checkpoints WHERE checkpoint_key = ?").get(checkpointKey);

    return (row as ReviewCheckpointRecord) || null;
  }

  /**
   * Retrieves the latest valid review checkpoint for a repo and item number.
   * Excludes checkpoints marked 'invalid'.
   */
  public getLatestValidCheckpoint(repo: string, itemNumber: number): ReviewCheckpointRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM review_checkpoints
         WHERE repo = ? AND item_number = ? AND (checkpoint_status IS NULL OR checkpoint_status != 'invalid')
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(repo, itemNumber);

    return (row as ReviewCheckpointRecord) || null;
  }

  /**
   * Synchronizes valid review checkpoints into a VectorStore reviews table.
   * Returns the count of reviews synced.
   */
  public syncCheckpointsToStore(store: { saveReview: (review: any) => void }, repo?: string): number {
    const query = repo
      ? "SELECT * FROM review_checkpoints WHERE repo = ? AND (checkpoint_status IS NULL OR checkpoint_status != 'invalid')"
      : "SELECT * FROM review_checkpoints WHERE (checkpoint_status IS NULL OR checkpoint_status != 'invalid')";
    const rows = (repo ? this.db.prepare(query).all(repo) : this.db.prepare(query).all()) as ReviewCheckpointRecord[];

    let count = 0;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.result_json);
        const findings = Array.isArray(parsed.findings)
          ? parsed.findings.map((f: any) => (typeof f === "string" ? f : f.message || JSON.stringify(f)))
          : Array.isArray(parsed.concerns)
            ? parsed.concerns
            : [];

        store.saveReview({
          number: row.item_number,
          repo: row.repo,
          type: row.item_type,
          provider: row.provider,
          model: row.model,
          summary: parsed.summary || "",
          concerns: findings,
          recommendation:
            parsed.recommendation || (parsed.issueAction === "close_duplicate" ? "close" : "needs_human_review"),
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
          reviewedAt: row.completed_at,
        });
        count++;
      } catch {
        // ignore parse errors
      }
    }
    return count;
  }

  /**
   * Retrieve a job by ID.
   */
  public getJob(jobId: string): ReviewJobRecord | null {
    const row = this.db.prepare("SELECT * FROM review_jobs WHERE job_id = ?").get(jobId);
    return (row as ReviewJobRecord) || null;
  }

  /**
   * List jobs, optionally filtered by status.
   */
  public listJobs(status?: ReviewJobStatus): ReviewJobRecord[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM review_jobs WHERE status = ? ORDER BY priority_score DESC, item_number ASC")
        .all(status) as ReviewJobRecord[];
    }
    return this.db
      .prepare("SELECT * FROM review_jobs ORDER BY priority_score DESC, item_number ASC")
      .all() as ReviewJobRecord[];
  }

  /**
   * List jobs filtered by item type and/or status array.
   * Used by --prs-only, --issues-only, and filter flags in the CLI.
   */
  public listJobsByFilter(filter: {
    itemType?: "pr" | "issue";
    status?: ReviewJobStatus[];
    isOpen?: boolean;
  }): ReviewJobRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.itemType) {
      conditions.push("item_type = ?");
      params.push(filter.itemType);
    }

    if (filter.status && filter.status.length > 0) {
      const placeholders = filter.status.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      for (const s of filter.status) {
        params.push(s);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM review_jobs ${where} ORDER BY priority_score DESC, item_number ASC`)
      .all(...params) as ReviewJobRecord[];

    // Apply isOpen filter on payload JSON if requested
    if (filter.isOpen !== undefined) {
      return rows.filter((row) => {
        try {
          const payload = JSON.parse(row.payload_json);
          return payload.isOpen === filter.isOpen;
        } catch {
          return false;
        }
      });
    }

    return rows;
  }

  /**
   * List recent failed jobs (last N by updated_at).
   */
  public listRecentFailures(limit: number = 5): ReviewJobRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM review_jobs WHERE status IN ('failed', 'rejected_permanent') ORDER BY updated_at DESC LIMIT ?",
      )
      .all(limit) as ReviewJobRecord[];
  }

  /**
   * List active (unexpired) leases.
   */
  public listActiveLeases(
    nowMs: number = Date.now(),
  ): Array<{ account_id: string; job_id: string; expires_at: number }> {
    return this.db
      .prepare("SELECT account_id, job_id, expires_at FROM account_leases WHERE expires_at > ?")
      .all(nowMs) as Array<{ account_id: string; job_id: string; expires_at: number }>;
  }

  /**
   * Get queue counts grouped by status.
   */
  public getQueueStats(): QueueStats {
    const rows = this.db.prepare("SELECT status, COUNT(*) as count FROM review_jobs GROUP BY status").all() as Array<{
      status: string;
      count: number;
    }>;

    const stats: QueueStats = {
      queued: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      rejected_permanent: 0,
      invalid: 0,
      total: 0,
    };

    for (const row of rows) {
      if (row.status in stats) {
        (stats as any)[row.status] = row.count;
      }
      stats.total += row.count;
    }
    return stats;
  }

  /**
   * Get number of active (unexpired) leases, optionally for a specific account.
   */
  public getActiveLeaseCount(accountId?: string): number {
    const now = Date.now();
    if (accountId) {
      const row = this.db
        .prepare("SELECT COUNT(*) as count FROM account_leases WHERE account_id = ? AND expires_at > ?")
        .get(accountId, now) as { count: number };
      return row.count;
    }
    const row = this.db.prepare("SELECT COUNT(*) as count FROM account_leases WHERE expires_at > ?").get(now) as {
      count: number;
    };
    return row.count;
  }

  /**
   * Get aggregated usage ledger summary grouped by account.
   */
  public getUsageSummaryByAccount(): Record<string, AccountUsageSummary> {
    const rows = this.db
      .prepare(`
        SELECT
          account_id,
          COUNT(*) as total_requests,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failure_count,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          MAX(recorded_at) as last_seen
        FROM account_usage_ledger
        GROUP BY account_id
      `)
      .all() as Array<{
      account_id: string;
      total_requests: number;
      success_count: number;
      failure_count: number;
      prompt_tokens: number;
      completion_tokens: number;
      last_seen: string;
    }>;

    const result: Record<string, AccountUsageSummary> = {};
    for (const row of rows) {
      result[row.account_id] = {
        accountId: row.account_id,
        totalRequests: Number(row.total_requests) || 0,
        successCount: Number(row.success_count) || 0,
        failureCount: Number(row.failure_count) || 0,
        promptTokens: Number(row.prompt_tokens) || 0,
        completionTokens: Number(row.completion_tokens) || 0,
        lastSeen: row.last_seen || "",
      };
    }
    return result;
  }

  /**
   * Close the underlying SQLite database.
   */
  public close(): void {
    this.db.close();
  }

  /**
   * Quarantine specific smoke-test checkpoints/jobs by marking them as "invalid".
   * Used to retroactively mark known-bad historical results (e.g. rawContent placeholders,
   * empty JSON completions) without affecting other jobs.
   *
   * @param smokeTestJobIds - Job IDs to mark as invalid
   * @returns Number of jobs successfully quarantined
   */
  public quarantineSmokeTestCheckpoints(smokeTestJobIds: string[]): number {
    return this.runImmediate(() => {
      let count = 0;
      const isoNow = new Date().toISOString();

      for (const jobId of smokeTestJobIds) {
        const job = this.db.prepare("SELECT * FROM review_jobs WHERE job_id = ?").get(jobId) as
          | ReviewJobRecord
          | undefined;

        if (!job) {
          continue;
        }

        // Mark the job as invalid
        const result = this.db
          .prepare("UPDATE review_jobs SET status = 'invalid', updated_at = ? WHERE job_id = ?")
          .run(isoNow, jobId);

        if (result.changes > 0) {
          count++;
        }

        // Mark the associated checkpoint as invalid (if it exists)
        const checkpointKey = `${job.repo}:${job.item_type}:${job.item_number}:${job.input_fingerprint}:${job.prompt_schema_version}`;
        this.db
          .prepare("UPDATE review_checkpoints SET checkpoint_status = 'invalid' WHERE checkpoint_key = ?")
          .run(checkpointKey);
      }

      return count;
    });
  }
}
