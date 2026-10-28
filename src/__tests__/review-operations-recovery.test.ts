import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { batches, type Evidence, hash, modelFingerprint } from "../review-operations/contracts.js";
import { runOperations } from "../review-operations/runner.js";
import { OperationsStore } from "../review-operations/store.js";
import { getIsolatedEnv } from "./cli-test-env.js";

const directories: string[] = [];
const stores: OperationsStore[] = [];
const item: Evidence = {
  repo: "example/project",
  kind: "issue",
  number: 1,
  state: "open",
  title: "Fixture",
  body: "body",
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
const account = { id: "test", model: "test", endpoint: "https://model.invalid", keyEnv: "FAKE" };
const answer = { summary: "Unverified", category: "human_review", findings: [], uncertainty: [] };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "prism-crash-"));
  directories.push(dir);
  const file = join(dir, "queue.sqlite");
  const store = new OperationsStore(file);
  stores.push(store);
  store.put(item);
  writeFileSync(join(dir, "item.json"), JSON.stringify(item));
  writeFileSync(join(dir, "sentinel"), "do not alter");
  const worker = join(dir, "worker.mjs");
  writeFileSync(
    worker,
    `
import {OperationsStore} from ${JSON.stringify(`file://${resolve("dist/review-operations/store.js")}`)};
import {runOperations} from ${JSON.stringify(`file://${resolve("dist/review-operations/runner.js")}`)};
import fs,{readFileSync,appendFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
const [dir,stage,accountId="test"]=process.argv.slice(2), store=new OperationsStore(dir+"/queue.sqlite");
const item=JSON.parse(readFileSync(dir+"/item.json","utf8"));
const freeze=()=>{process.stdout.write("READY\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
if(stage==="before-reserve"){const original=store.claim.bind(store);store.claim=(...a)=>{const job=original(...a);if(job)freeze();return job;};}
if(stage==="after-reserve"){const original=store.reserve.bind(store);store.reserve=(...a)=>{const id=original(...a);if(id)freeze();return id;};}
if(stage==="during-draft-temp"){const write=fs.writeFileSync;fs.writeFileSync=(...a)=>{const result=write(...a);if(typeof a[0]==="number")freeze();return result;};syncBuiltinESMExports();}
if(stage==="after-json"||stage==="after-markdown"){const link=fs.linkSync;fs.linkSync=(...a)=>{const result=link(...a);if(stage==="after-json"&&a[1].endsWith(".json")||stage==="after-markdown"&&a[1].endsWith(".md"))freeze();return result;};syncBuiltinESMExports();}
if(stage==="during-reservation"){const original=store.db.prepare.bind(store.db);store.db.prepare=sql=>{const stmt=original(sql);if(sql.startsWith("UPDATE v5_runs SET spent=spent+1")){const run=stmt.run.bind(stmt);stmt.run=(...a)=>{const result=run(...a);freeze();return result;};}return stmt;};}
if(stage==="during-checkpoint"){const original=store.db.prepare.bind(store.db);store.db.prepare=sql=>{const stmt=original(sql);if(sql.startsWith("UPDATE v5_attempts SET state=?")){const run=stmt.run.bind(stmt);stmt.run=(...a)=>{const result=run(...a);freeze();return result;};}return stmt;};}
if(stage==="after-checkpoint"){const original=store.finish.bind(store);store.finish=(...a)=>{const result=original(...a);freeze();return result;};}
if(stage==="before-finalize"||stage==="after-finalize"){const original=store.ownedSet.bind(store);store.ownedSet=(...a)=>{if(a[2]==="completed_current"&&stage==="before-finalize")freeze();const result=original(...a);if(a[2]==="completed_current"&&stage==="after-finalize")freeze();return result;};}
const snapshot=await runOperations({store,source:{inventory:async()=>[1],get:async(_r,k,n)=>({...item,kind:k,number:n})},model:async(_a,e)=>{appendFileSync(dir+"/provider-observed",JSON.stringify({number:e.number,account:accountId})+"\\n");if(stage==="during-request")freeze();await new Promise(r=>setTimeout(r,5));return {value:${JSON.stringify(answer)}};},accounts:[{...${JSON.stringify(account)},id:accountId}],repo:item.repo,kind:item.kind,runId:stage==="compete"?"shared":"crash",budget:stage==="compete"?5:2,output:dir+"/drafts"});
store.close();console.log(JSON.stringify(snapshot));
`,
  );
  return { store, dir, file, worker };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Actual worker termination boundaries", () => {
  it.each([
    "before-reserve",
    "after-reserve",
    "during-reservation",
    "during-draft-temp",
    "after-json",
    "after-markdown",
    "during-request",
    "during-checkpoint",
    "after-checkpoint",
    "before-finalize",
    "after-finalize",
  ])("recovers safely after SIGKILL at %s", async (stage) => {
    const { store, dir, worker } = setup();
    const sourceSentinel = hash(readFileSync(resolve("README.md")));
    const child = spawn(process.execPath, [worker, dir, stage], {
      env: getIsolatedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (d) => {
      errors += d;
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Child boundary timeout ${errors}`));
      }, 10000);
      child.stdout.on("data", (d) => {
        if (d.toString().includes("READY")) {
          clearTimeout(timer);
          done();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Child exited before boundary ${errors}`));
      });
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const uncertain = ["after-reserve", "during-request", "during-checkpoint"].includes(stage);
    const result = store.recover(item.repo, item.kind, Date.now() + 120000);
    expect(result.uncertain).toBe(uncertain ? 1 : 0);
    const initial = store.snapshot(item.repo, item.kind);
    expect(initial.requests.uncertain).toBe(uncertain ? 1 : 0);
    expect(initial.runs[0]?.spent).toBe(["before-reserve", "during-reservation"].includes(stage) ? 0 : 1);
    let calls = 0;
    const run = () =>
      runOperations({
        store,
        source: { inventory: async () => [1], get: async () => item },
        model: async () => {
          calls++;
          return { value: answer };
        },
        accounts: [account],
        repo: item.repo,
        kind: item.kind,
        runId: "crash",
        budget: 2,
        output: join(dir, "drafts"),
      });
    await run();
    expect(calls).toBe(["before-reserve", "during-reservation"].includes(stage) ? 1 : 0);
    if (uncertain) {
      const attempt = initial.attempts.find((a) => a.state === "uncertain")!;
      expect(() => store.acknowledgeUncertain(item.repo, "pr", attempt.id)).toThrow();
      store.acknowledgeUncertain(item.repo, item.kind, attempt.id);
      await run();
      expect(calls).toBe(1);
      expect(store.snapshot(item.repo, item.kind).runs[0].spent).toBe(2);
    }
    expect(store.snapshot(item.repo, item.kind).counts.completed_current).toBe(1);
    expect(readFileSync(join(dir, "sentinel"), "utf8")).toBe("do not alter");
    expect(hash(readFileSync(resolve("README.md")))).toBe(sourceSentinel);
    if (
      [
        "after-checkpoint",
        "before-finalize",
        "after-finalize",
        "during-draft-temp",
        "after-json",
        "after-markdown",
      ].includes(stage)
    )
      expect(
        store.checkpoint(store.jobs(item.repo, item.kind)[0].id, modelFingerprint(account), batches(item)[0].hash),
      ).toBeDefined();
  });
  it.each([
    "distinct",
    "same",
  ])("enforces a shared durable budget across three competing processes with %s accounts", async (mode) => {
    const { store, dir, worker } = setup();
    for (let i = 2; i <= 10; i++) store.put({ ...item, number: i });
    const children = ["a", "b", "c"].map((id) =>
      spawn(process.execPath, [worker, dir, "compete", mode === "same" ? "single" : id], {
        env: getIsolatedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    await Promise.all(
      children.map(async (child) => {
        let errors = "";
        child.stderr.on("data", (d) => {
          errors += d;
        });
        child.stdout.resume();
        const [code] = await once(child, "exit");
        expect(code, errors).toBe(0);
      }),
    );
    const snap = store.snapshot(item.repo, item.kind);
    expect(snap.runs[0].spent).toBe(5);
    expect(snap.attempts).toHaveLength(5);
    expect(readFileSync(join(dir, "provider-observed"), "utf8").trim().split("\n")).toHaveLength(5);
    expect(new Set(snap.attempts.map((a) => a.job)).size).toBe(5);
  });
  it("backs up the prior V5 schema and preserves exact checkpoint identity", () => {
    const { store, dir, file } = setup();
    store.startRun("legacy", 1);
    const j = store.claim(item.repo, item.kind, "owner")!;
    const id = store.reserve("legacy", j, account.id, modelFingerprint(account), 0, batches(item)[0].hash, "owner", 3)!;
    store.finish(id, "completed", answer);
    store.release(j.id, "owner");
    store.db.pragma("user_version=5");
    const next = new OperationsStore(file);
    stores.push(next);
    expect(readdirSync(dir).some((n) => n.includes(".v5-") && n.endsWith(".backup"))).toBe(true);
    expect(next.checkpoint(j.id, modelFingerprint(account), batches(item)[0].hash)).toBeDefined();
    expect(next.snapshot(item.repo, item.kind).runs[0].spent).toBe(1);
  });
  it("fences stale workers from dispatch or finalization, and read-only status coexists with a writer", () => {
    const { store, file } = setup();
    store.startRun("r", 1);
    const job = store.claim(item.repo, item.kind, "old")!;
    store.db.prepare("UPDATE v5_jobs SET expires=0").run();
    store.recover(item.repo, item.kind);
    expect(store.reserve("r", job, "a", "m", 0, "h", "old", 3)).toBeUndefined();
    expect(store.ownedSet(job.id, "old", "completed_current")).toBe(false);
    const reader = new OperationsStore(file, true);
    stores.push(reader);
    const before = reader.snapshot(item.repo, item.kind);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.db.prepare("UPDATE v5_jobs SET reason='uncommitted'").run();
      expect(reader.snapshot(item.repo, item.kind)).toEqual(before);
    } finally {
      store.db.exec("ROLLBACK");
    }
  });
});

describe("Uncertainty isolation", () => {
  it("blocks another job/account alias while a timeout outcome is uncertain", async () => {
    const { store, dir } = setup();
    store.put({ ...item, number: 2 });
    let calls = 0;
    await runOperations({
      store,
      source: { inventory: async () => [], get: async (_r, _k, n) => ({ ...item, number: n }) },
      model: async () => {
        calls++;
        throw new DOMException("timed out", "TimeoutError");
      },
      accounts: [{ ...account, leaseKey: "shared-credential" }],
      repo: item.repo,
      kind: item.kind,
      runId: "r",
      budget: 3,
      output: join(dir, "drafts"),
    });
    expect(calls).toBe(1);
    const job = store.claim(item.repo, item.kind, "another")!;
    expect(store.reserve("r", job, "alias", "m", 0, "h", "another", 3, "shared-credential")).toBeUndefined();
    expect(store.snapshot(item.repo, item.kind).requests.uncertain).toBe(1);
  });
});
