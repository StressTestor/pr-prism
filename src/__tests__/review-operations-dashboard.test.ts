import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderSnapshot } from "../review-operations/cli.js";
import { batches, type Evidence, modelFingerprint } from "../review-operations/contracts.js";
import { OperationsStore } from "../review-operations/store.js";

const dirs: string[] = [];
const stores: OperationsStore[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "prism-dashboard-"));
  dirs.push(dir);
  const store = new OperationsStore(join(dir, "queue.sqlite"));
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const e: Evidence = {
  repo: "example/project",
  kind: "issue",
  number: 1,
  state: "open",
  title: "Fixture",
  body: "x".repeat(70000),
  author: "test",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
  labels: [],
  comments: [],
  events: [],
  files: [],
  limitations: [],
  observedAt: "2026-01-03",
};
const account = { id: "account", model: "model", endpoint: "https://model.invalid", keyEnv: "FAKE" };
describe("Dashboard observations", () => {
  it("reports empty and zero-throughput states and handles narrow terminal resize", () => {
    const store = setup();
    const snap = store.snapshot(e.repo, e.kind);
    expect(snap.totalOpen).toBe(0);
    expect(snap.eta.backlogSeconds).toBeNull();
    expect(snap.throughput.completedBatchesPerMinute).toBeNull();
    const rendered = renderSnapshot(snap, 45, 10);
    expect(rendered.split("\n").length).toBeLessThanOrEqual(9);
    expect(rendered.split("\n").every((line) => line.length <= 45)).toBe(true);
    expect(renderSnapshot(snap)).toContain("N/A");
  });
  it("reports active item/batch/account, scoped requests, throughput and distinct bounded/backlog ETA", () => {
    const store = setup();
    store.put(e);
    for (let n = 2; n <= 5; n++) store.put({ ...e, number: n, body: "short" });
    store.startRun("budget", 4);
    const job = store.claim(e.repo, e.kind, "worker")!;
    const plan = batches(e);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const id = store.reserve("budget", job, account.id, modelFingerprint(account), i, plan[i].hash, "worker", 3)!;
      store.finish(id, "completed", {}, 10000);
      store.db
        .prepare("UPDATE v5_attempts SET started=?,finished=? WHERE id=?")
        .run(now - 40000 + i * 10000, now - 30000 + i * 10000, id);
      store.db.prepare("DELETE FROM v5_leases").run();
    }
    const snap = store.snapshot(e.repo, e.kind);
    expect(snap.requests.remainingBudget).toBe(1);
    expect(snap.throughput.completedBatchesPerMinute).toBeGreaterThan(0);
    expect(snap.eta.backlogSeconds!).toBeGreaterThan(snap.eta.boundedStopSeconds!);
    expect(snap.eta.backlogRangeSeconds).toHaveLength(2);
    store.reserve("budget", job, account.id, modelFingerprint(account), 3, plan[3].hash, "worker", 3);
    const active = store.snapshot(e.repo, e.kind);
    expect(active.active[0]).toMatchObject({ number: 1, batch: 4, account: "account", totalBatches: 4 });
    expect(active.requests.reserved).toBe(4);
    expect(renderSnapshot(active)).toContain("batch 4/4");
  });
  it("distinguishes latest stale/missing work, partial legacy claims, external resolution and crash uncertainty", () => {
    const store = setup();
    const first = store.put(e);
    store.set(first, "completed_current");
    store.put({ ...e, body: "changed" });
    store.put({ ...e, number: 2, state: "closed" });
    store.startRun("run", 1);
    const job = store.claim(e.repo, e.kind, "dead")!;
    store.reserve("run", job, account.id, "model", 0, "hash", "dead", 3);
    store.db.prepare("UPDATE v5_jobs SET expires=0").run();
    const snap = store.snapshot(e.repo, e.kind);
    expect(snap.staleItems).toBe(1);
    expect(snap.missingCurrent).toBe(1);
    expect(snap.externallyHandled).toBe(1);
    expect(snap.requests.uncertain).toBe(1);
    expect(snap.active[0].leaseExpired).toBe(true);
  });
});
