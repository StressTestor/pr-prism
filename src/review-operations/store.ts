import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { batches, type Evidence, fingerprint, hash, type Kind, type State } from "./contracts.js";
import { coverageProblems } from "./integrity.js";

export interface Job {
  id: string;
  repo: string;
  kind: Kind;
  number: number;
  fingerprint: string;
  evidence: string;
  state: State;
  reason: string | null;
  owner: string | null;
  expires: number | null;
}
export class OperationsStore {
  readonly db: Database.Database;
  constructor(file: string, readonly = false) {
    if (!readonly) mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { readonly, fileMustExist: readonly, timeout: 1000 });
    if (!readonly) {
      // A dedicated database avoids migrations or reinterpretation of the V4 ledger.
      const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      if (existing.length && !existing.some((t) => t.name === "v5_jobs")) {
        this.db.close();
        throw new Error("Refusing non-V5 database; offline migration required");
      }
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version > 6) {
        this.db.close();
        throw new Error("Unsupported operations schema version");
      }
      if (existing.length && version < 6)
        this.db.prepare("VACUUM INTO ?").run(`${file}.v${version}-${randomUUID()}.backup`);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS v5_jobs(id TEXT PRIMARY KEY, repo TEXT, kind TEXT, number INTEGER, fingerprint TEXT, evidence TEXT, state TEXT, reason TEXT, owner TEXT, expires INTEGER);
        CREATE INDEX IF NOT EXISTS v5_jobs_identity ON v5_jobs(repo,kind,number);
        CREATE TABLE IF NOT EXISTS v5_current(repo TEXT,kind TEXT,number INTEGER,id TEXT,PRIMARY KEY(repo,kind,number));
        CREATE TABLE IF NOT EXISTS v5_runs(id TEXT PRIMARY KEY, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS v5_attempts(id TEXT PRIMARY KEY, run TEXT, job TEXT, account TEXT, model TEXT, batch INTEGER, batch_hash TEXT, state TEXT, result TEXT, started INTEGER, finished INTEGER, latency REAL, spend REAL);
        CREATE TABLE IF NOT EXISTS v5_leases(account TEXT PRIMARY KEY, owner TEXT, expires INTEGER);
        CREATE TABLE IF NOT EXISTS v5_sync(repo TEXT, kind TEXT, value TEXT, PRIMARY KEY(repo,kind));
        CREATE TABLE IF NOT EXISTS v5_events(id INTEGER PRIMARY KEY, job TEXT, kind TEXT, observed INTEGER, value TEXT);
        CREATE TABLE IF NOT EXISTS v5_attempt_accounts(attempt TEXT PRIMARY KEY,lease_key TEXT);
        CREATE TABLE IF NOT EXISTS v5_control(key TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
        CREATE TABLE IF NOT EXISTS v5_run_scope(run TEXT,repo TEXT,kind TEXT,PRIMARY KEY(run,repo,kind));
        PRAGMA user_version=6;`);
    }
  }
  close() {
    this.db.close();
  }
  jobs(repo: string, kind: Kind): Job[] {
    return this.db.prepare("SELECT * FROM v5_jobs WHERE repo=? AND kind=? ORDER BY number,id").all(repo, kind) as Job[];
  }
  event(job: string, kind: string, value: unknown) {
    this.db
      .prepare("INSERT INTO v5_events(job,kind,observed,value) VALUES(?,?,?,?)")
      .run(job, kind, Date.now(), JSON.stringify(value));
  }
  put(e: Evidence) {
    const fp = fingerprint(e);
    const id = hash([e.repo, e.kind, e.number, fp]);
    this.db
      .transaction(() => {
        const previous = this.db
          .prepare(
            "SELECT * FROM v5_jobs WHERE repo=? AND kind=? AND number=? AND fingerprint!=? AND state NOT IN ('stale','externally_resolved')",
          )
          .all(e.repo, e.kind, e.number, fp) as Job[];
        for (const j of previous) {
          this.set(
            j.id,
            e.state === "open" ? "stale" : "externally_resolved",
            e.state === "open" ? "evidence_changed" : e.state,
          );
        }
        this.db
          .prepare("INSERT OR IGNORE INTO v5_jobs VALUES(?,?,?,?,?,?,?,?,NULL,NULL)")
          .run(
            id,
            e.repo,
            e.kind,
            e.number,
            fp,
            JSON.stringify(e),
            e.state === "open" ? "pending" : "externally_resolved",
            e.state === "open" ? null : e.state,
          );
        this.db.prepare("INSERT OR REPLACE INTO v5_current VALUES(?,?,?,?)").run(e.repo, e.kind, e.number, id);
        this.db
          .prepare(
            "UPDATE v5_jobs SET state='pending',reason='reopened' WHERE id=? AND state IN ('stale','externally_resolved') AND ?='open'",
          )
          .run(id, e.state);
        this.event(id, "remote_observation", e);
        for (const event of e.events as any[]) {
          const type =
            event.state === "APPROVED"
              ? "approved_elsewhere"
              : event.state === "CHANGES_REQUESTED"
                ? "changes_requested_elsewhere"
                : event.event;
          if (type)
            this.event(id, type, {
              who: event.user?.login ?? event.actor?.login,
              when: event.submitted_at ?? event.created_at,
              observedAt: e.observedAt,
            });
        }
      })
      .immediate();
    return id;
  }
  set(id: string, state: State, reason: string | null = null) {
    this.db.prepare("UPDATE v5_jobs SET state=?,reason=? WHERE id=?").run(state, reason, id);
    this.event(id, state, { reason });
  }
  sync(repo: string, kind: Kind, value: any) {
    const old = this.db.prepare("SELECT value FROM v5_sync WHERE repo=? AND kind=?").get(repo, kind) as
      | { value: string }
      | undefined;
    value = {
      ...value,
      lastReliableSync: value.reliable ? value.completed : old ? JSON.parse(old.value).lastReliableSync : null,
    };
    this.db.prepare("INSERT OR REPLACE INTO v5_sync VALUES(?,?,?)").run(repo, kind, JSON.stringify(value));
  }
  startRun(id: string, budget: number) {
    if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("max-new-calls must be a nonnegative integer");
    this.db.prepare("INSERT OR IGNORE INTO v5_runs(id,budget,state) VALUES(?,?,'running')").run(id, budget);
    const run = this.db.prepare("SELECT * FROM v5_runs WHERE id=?").get(id) as { budget: number };
    if (run.budget !== budget) throw new Error("Resumed run budget must match original budget");
    this.db.prepare("UPDATE v5_runs SET state='running' WHERE id=?").run(id);
  }
  claim(repo: string, kind: Kind, owner: string): Job | undefined {
    return this.db
      .transaction(() => {
        const now = Date.now();
        this.recover(repo, kind, now);
        const job = this.db
          .prepare(
            "SELECT * FROM v5_jobs WHERE repo=? AND kind=? AND (state='pending' OR (state='partial' AND reason IN ('budget_stop','account_or_worker_busy','recovered_checkpoint'))) AND owner IS NULL AND NOT EXISTS (SELECT 1 FROM v5_jobs live WHERE live.repo=v5_jobs.repo AND live.kind=v5_jobs.kind AND live.number=v5_jobs.number AND live.owner IS NOT NULL AND live.expires>?) AND id IN (SELECT id FROM v5_current WHERE repo=v5_jobs.repo AND kind=v5_jobs.kind) ORDER BY number,id LIMIT 1",
          )
          .get(repo, kind, now) as Job | undefined;
        if (job)
          this.db
            .prepare("UPDATE v5_jobs SET owner=?,expires=?,state='active' WHERE id=?")
            .run(owner, now + 60000, job.id);
        return job;
      })
      .immediate();
  }
  recover(repo: string, kind: Kind, now = Date.now()) {
    return this.db
      .transaction(() => {
        const jobs = this.db
          .prepare(
            "SELECT * FROM v5_jobs WHERE repo=? AND kind=? AND ((owner IS NOT NULL AND expires<=?) OR (owner IS NULL AND state='paused' AND reason='cancelled'))",
          )
          .all(repo, kind, now) as Job[];
        let resumed = 0,
          uncertain = 0;
        for (const j of jobs) {
          const pending = this.db
            .prepare("UPDATE v5_attempts SET state='uncertain' WHERE job=? AND state='attempted'")
            .run(j.id).changes;
          this.db.prepare("DELETE FROM v5_leases WHERE owner=? AND expires<=?").run(j.owner, now);
          if (j.state === "active" || (j.state === "paused" && j.reason === "cancelled")) {
            this.set(j.id, pending ? "paused" : "partial", pending ? "uncertain_request" : "recovered_checkpoint");
            if (pending) uncertain++;
            else resumed++;
          }
          this.db.prepare("UPDATE v5_jobs SET owner=NULL,expires=NULL WHERE id=?").run(j.id);
          this.event(j.id, "crash_recovery", { reservedRequestsUncertain: pending, previousOwner: j.owner });
        }
        return { resumed, uncertain };
      })
      .immediate();
  }
  acknowledgeUncertain(repo: string, kind: Kind, attempt: string) {
    return this.db
      .transaction(() => {
        const a = this.db
          .prepare(
            "SELECT a.* FROM v5_attempts a JOIN v5_jobs j ON j.id=a.job WHERE a.id=? AND j.repo=? AND j.kind=? AND a.state='uncertain' AND j.owner IS NULL",
          )
          .get(attempt, repo, kind) as { job: string } | undefined;
        if (!a) throw new Error("Unknown uncertain attempt, wrong item type, or active worker");
        this.db.prepare("UPDATE v5_attempts SET state='uncertain_acknowledged' WHERE id=?").run(attempt);
        this.event(a.job, "operator_authorized_retry", { attempt, originalReservationRetained: true });
        if (!this.db.prepare("SELECT 1 FROM v5_attempts WHERE job=? AND state='uncertain'").get(a.job))
          this.db
            .prepare("UPDATE v5_jobs SET state='partial',reason='recovered_checkpoint' WHERE id=? AND state='paused'")
            .run(a.job);
      })
      .immediate();
  }
  ownedSet(id: string, owner: string, state: State, reason: string | null = null) {
    return this.db
      .transaction(() => {
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM v5_jobs j JOIN v5_current c ON c.id=j.id WHERE j.id=? AND j.owner=? AND j.expires>? AND j.state='active'",
            )
            .get(id, owner, Date.now())
        )
          return false;
        this.set(id, state, reason);
        return true;
      })
      .immediate();
  }
  syncLock(repo: string, kind: Kind, owner: string) {
    return this.db
      .transaction(() => {
        const key = `sync:${repo}:${kind}`;
        this.db.prepare("DELETE FROM v5_control WHERE key=? AND expires<?").run(key, Date.now());
        return (
          this.db.prepare("INSERT OR IGNORE INTO v5_control VALUES(?,?,?)").run(key, owner, Date.now() + 60000)
            .changes > 0
        );
      })
      .immediate();
  }
  syncFence(repo: string, kind: Kind, owner: string) {
    if (
      !this.db
        .prepare("SELECT 1 FROM v5_control WHERE key=? AND owner=? AND expires>?")
        .get(`sync:${repo}:${kind}`, owner, Date.now())
    )
      throw new Error("Lost reconciliation lease");
  }
  syncHeartbeat(repo: string, kind: Kind, owner: string) {
    this.db
      .prepare("UPDATE v5_control SET expires=? WHERE key=? AND owner=?")
      .run(Date.now() + 60000, `sync:${repo}:${kind}`, owner);
  }
  syncUnlock(repo: string, kind: Kind, owner: string) {
    this.db.prepare("DELETE FROM v5_control WHERE key=? AND owner=?").run(`sync:${repo}:${kind}`, owner);
  }
  syncState(repo: string, kind: Kind): any {
    const row = this.db.prepare("SELECT value FROM v5_sync WHERE repo=? AND kind=?").get(repo, kind) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  heartbeat(owner: string) {
    const now = Date.now();
    this.db
      .transaction(() => {
        const renewed = this.db
          .prepare("UPDATE v5_jobs SET expires=? WHERE owner=? AND expires>?")
          .run(now + 60000, owner, now).changes;
        if (renewed)
          this.db.prepare("UPDATE v5_leases SET expires=? WHERE owner=? AND expires>?").run(now + 60000, owner, now);
      })
      .immediate();
  }
  release(job: string, owner: string) {
    this.db.prepare("UPDATE v5_jobs SET owner=NULL,expires=NULL WHERE id=? AND owner=?").run(job, owner);
    this.db.prepare("DELETE FROM v5_leases WHERE owner=?").run(owner);
  }
  reserve(
    run: string,
    job: Job,
    account: string,
    model: string,
    batch: number,
    batchHash: string,
    owner: string,
    cap: number,
    leaseAccount = account,
  ): string | undefined {
    return this.db
      .transaction(() => {
        const now = Date.now();
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM v5_jobs j JOIN v5_current c ON c.id=j.id WHERE j.id=? AND j.owner=? AND j.expires>? AND j.state='active'",
            )
            .get(job.id, owner, now)
        )
          return undefined;
        this.db.prepare("INSERT OR IGNORE INTO v5_run_scope VALUES(?,?,?)").run(run, job.repo, job.kind);
        if (
          this.db
            .prepare(
              "SELECT 1 FROM v5_attempts a LEFT JOIN v5_attempt_accounts s ON s.attempt=a.id WHERE (a.account=? OR s.lease_key=?) AND (a.state='uncertain' OR (a.state='attempted' AND NOT EXISTS (SELECT 1 FROM v5_leases l WHERE l.account=? AND l.expires>?)))",
            )
            .get(account, leaseAccount, leaseAccount, now)
        )
          return undefined;
        this.db.prepare("DELETE FROM v5_leases WHERE expires<?").run(now);
        const count = this.db.prepare("SELECT COUNT(*) n FROM v5_leases").get() as { n: number };
        if (count.n >= cap || this.db.prepare("SELECT 1 FROM v5_leases WHERE account=?").get(leaseAccount))
          return undefined;
        if (!this.db.prepare("UPDATE v5_runs SET spent=spent+1 WHERE id=? AND spent<budget").run(run).changes)
          return undefined;
        const id = randomUUID();
        this.db.prepare("INSERT INTO v5_leases VALUES(?,?,?)").run(leaseAccount, owner, now + 60000);
        this.db
          .prepare(
            "INSERT INTO v5_attempts(id,run,job,account,model,batch,batch_hash,state,started) VALUES(?,?,?,?,?,?,?,'attempted',?)",
          )
          .run(id, run, job.id, account, model, batch, batchHash, now);
        this.db.prepare("INSERT INTO v5_attempt_accounts VALUES(?,?)").run(id, leaseAccount);
        return id;
      })
      .immediate();
  }
  finish(id: string, state: string, result: unknown, latency?: number, spend?: number, owner?: string) {
    return this.db
      .transaction(() => {
        if (
          owner &&
          !this.db
            .prepare(
              "SELECT 1 FROM v5_attempts a JOIN v5_jobs j ON j.id=a.job WHERE a.id=? AND j.owner=? AND j.expires>? AND a.state='attempted'",
            )
            .get(id, owner, Date.now())
        )
          throw new Error("Lost worker lease; request outcome remains uncertain");
        return (
          this.db
            .prepare(
              "UPDATE v5_attempts SET state=?,result=?,finished=?,latency=?,spend=? WHERE id=? AND state='attempted'",
            )
            .run(state, JSON.stringify(result), Date.now(), latency ?? null, spend ?? null, id).changes > 0
        );
      })
      .immediate();
  }
  checkpoint(job: string, model: string, batchHash: string) {
    return this.db
      .prepare(
        "SELECT * FROM v5_attempts WHERE job=? AND model=? AND batch_hash=? AND state='completed' ORDER BY started LIMIT 1",
      )
      .get(job, model, batchHash);
  }
  snapshot(repo: string, kind: Kind) {
    return this.db.transaction(() => this.snapshotData(repo, kind)).deferred();
  }
  private snapshotData(repo: string, kind: Kind) {
    const jobs = this.jobs(repo, kind);
    const currentIds = new Set(
      (this.db.prepare("SELECT id FROM v5_current WHERE repo=? AND kind=?").all(repo, kind) as { id: string }[]).map(
        (j) => j.id,
      ),
    );
    const current = jobs.filter((j) => currentIds.has(j.id));
    const counts: Record<string, number> = {};
    const effectiveState = (j: Job) =>
      j.state === "completed_current" && coverageProblems(JSON.parse(j.evidence)).length ? "partial" : j.state;
    for (const j of current) {
      const state = effectiveState(j);
      counts[state] = (counts[state] ?? 0) + 1;
    }
    const attempts = this.db
      .prepare(
        "SELECT a.* FROM v5_attempts a JOIN v5_jobs j ON j.id=a.job WHERE j.repo=? AND j.kind=? ORDER BY started DESC",
      )
      .all(repo, kind) as any[];
    const known = current.filter(
      (j) =>
        j.state === "pending" ||
        j.state === "active" ||
        (j.state === "partial" &&
          ["budget_stop", "account_or_worker_busy", "recovered_checkpoint"].includes(j.reason ?? "")),
    );
    const minimumBatches = known.reduce(
      (n, j) =>
        n +
        batches(JSON.parse(j.evidence)).filter(
          (b) => !attempts.some((a) => a.job === j.id && a.batch_hash === b.hash && a.state === "completed"),
        ).length,
      0,
    );
    const historicalStale = jobs.filter((j) => j.state === "stale").length;
    const timings = attempts.filter((a) => a.state === "completed" && a.latency > 0);

    const hasScopes = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='v5_run_scope'").get());
    const runIds = new Set(attempts.map((a) => a.run));
    if (hasScopes)
      for (const s of this.db.prepare("SELECT run FROM v5_run_scope WHERE repo=? AND kind=?").all(repo, kind) as {
        run: string;
      }[])
        runIds.add(s.run);
    const runs = (this.db.prepare("SELECT * FROM v5_runs ORDER BY rowid DESC").all() as any[]).filter((r) =>
      runIds.has(r.id),
    );
    const recent = timings.filter((a) => a.finished >= Date.now() - 3600000);
    const batchLength = (a: any) => {
      const j = jobs.find((j) => j.id === a.job);
      return j ? (batches(JSON.parse(j.evidence))[a.batch]?.text.length ?? 0) : 0;
    };
    const duration =
      recent.length >= 3
        ? (Math.max(...recent.map((a) => a.finished)) - Math.min(...recent.map((a) => a.started))) / 1000
        : 0;
    const charRate = duration > 0 ? recent.reduce((n, a) => n + batchLength(a), 0) / duration : 0;
    const remaining = known.flatMap((j) =>
      batches(JSON.parse(j.evidence)).filter(
        (b) => !attempts.some((a) => a.job === j.id && a.batch_hash === b.hash && a.state === "completed"),
      ),
    );
    const inventoryKnown = current.filter((j) => {
      const e: Evidence = JSON.parse(j.evidence);
      return e.state === "open" && e.inventoryOnly;
    }).length;
    const seconds =
      !inventoryKnown && charRate > 0 ? remaining.reduce((n, b) => n + b.text.length, 0) / charRate : null;
    const activeRuns = runs.filter((r) => r.state === "running");
    const remainingBudget = (activeRuns.length ? activeRuns : runs.slice(0, 1)).reduce(
      (n, r) => n + Math.max(0, r.budget - r.spent),
      0,
    );
    const bounded =
      !inventoryKnown && charRate > 0
        ? remaining.slice(0, remainingBudget).reduce((n, b) => n + b.text.length, 0) / charRate
        : null;
    const staleItems = current.filter(
      (j) =>
        effectiveState(j) !== "completed_current" &&
        jobs.some((old) => old.number === j.number && old.state === "stale"),
    ).length;
    const sync = this.db.prepare("SELECT value FROM v5_sync WHERE repo=? AND kind=?").get(repo, kind) as
      | { value: string }
      | undefined;
    return {
      repo,
      type: kind,
      historicalStale,
      staleItems,
      missingCurrent: current.filter(
        (j) => JSON.parse(j.evidence).state === "open" && effectiveState(j) !== "completed_current",
      ).length,
      throughput: {
        completedBatchesPerMinute: duration > 0 ? (recent.length / duration) * 60 : null,
        evidenceCharsPerSecond: charRate || null,
        windowSeconds: duration,
      },
      requests: {
        reserved: attempts.length,
        completed: attempts.filter((a) => a.state === "completed").length,
        uncertain: attempts.filter(
          (a) =>
            a.state === "uncertain" ||
            (a.state === "attempted" && !jobs.some((j) => j.id === a.job && j.owner && j.expires! > Date.now())),
        ).length,
        remainingBudget,
      },
      inventoryKnown,
      evidenceFreshness:
        "Full evidence is current only at its last authoritative observation; inventory does not verify conversations",
      totalOpen: current.filter((j) => JSON.parse(j.evidence).state === "open").length,
      counts,
      eligible: known.length,
      skipped: counts.completed_current ?? 0,
      externallyHandled: counts.externally_resolved ?? 0,
      inProgress: counts.active ?? 0,
      blocked: counts.blocked ?? 0,
      estimatedMinimumEvidenceBatches: minimumBatches,
      active: current
        .filter((j) => j.owner)
        .map((j) => {
          const a = attempts.find((a) => a.job === j.id && a.state === "attempted");
          return {
            number: j.number,
            expires: j.expires,
            state: j.state,
            account: a?.account ?? null,
            batch: a ? a.batch + 1 : null,
            totalBatches: batches(JSON.parse(j.evidence)).length,
            leaseExpired: j.expires! <= Date.now(),
          };
        }),
      workers: this.db.prepare("SELECT account,expires FROM v5_leases WHERE expires>?").all(Date.now()),
      runs,
      rateLimit: (() => {
        const h = current.map((j) => JSON.parse(j.evidence)).find((e) => e.health)?.health;
        return h ? { remaining: h.remaining, reset: h.reset } : null;
      })(),
      recentEvents: this.db
        .prepare(
          "SELECT e.kind,e.observed,e.value FROM v5_events e JOIN v5_jobs j ON e.job=j.id WHERE j.repo=? AND j.kind=? AND e.kind!='remote_observation' ORDER BY e.id DESC LIMIT 10",
        )
        .all(repo, kind),
      perModel: this.db
        .prepare(
          "SELECT a.model,COUNT(*) attempts,SUM(a.latency) latencyMs,SUM(a.spend) reportedSpend FROM v5_attempts a JOIN v5_jobs j ON a.job=j.id WHERE j.repo=? AND j.kind=? GROUP BY a.model",
        )
        .all(repo, kind),
      attempts: attempts.map(({ result: _result, ...a }) => a),
      latestCheckpoints: attempts
        .filter((a) => a.state === "completed")
        .slice(0, 5)
        .map((a) => ({ job: a.job, batch: a.batch, finished: a.finished })),
      sync: sync ? JSON.parse(sync.value) : null,
      eta: {
        estimated: true,
        boundedStopSeconds: bounded,
        backlogSeconds: seconds,
        backlogRangeSeconds: seconds === null ? null : [seconds * 0.5, seconds * 2],
        boundedRangeSeconds: bounded === null ? null : [bounded * 0.5, bounded * 2],
        basis:
          "last-hour observed evidence characters / elapsed wall time (includes concurrent processing); indicative 0.5x–2x range; excludes unavailable evidence and future changes; N/A while inventory-only evidence remains",
      },
    };
  }
}
