import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSnapshot } from "../review-operations/cli.js";
import {
  type Account,
  batches,
  type Evidence,
  hash,
  type Kind,
  type Model,
  modelFingerprint,
  type Source,
  validateResult,
} from "../review-operations/contracts.js";
import { OperationsGitHub } from "../review-operations/github.js";
import { blobHash, coverageManifest } from "../review-operations/integrity.js";
import { reconcile, runOperations } from "../review-operations/runner.js";
import { OperationsStore } from "../review-operations/store.js";
import { getIsolatedEnv } from "./cli-test-env.js";

const dirs: string[] = [];
const stores: OperationsStore[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "prism-v5-"));
  dirs.push(d);
  return d;
};
function setup() {
  const dir = temp();
  const store = new OperationsStore(join(dir, "v5.sqlite"));
  stores.push(store);
  return { dir, store };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const evidence = (number = 1, kind: Kind = "pr"): Evidence => {
  const e: Evidence = {
    repo: "example/project",
    kind,
    number,
    state: "open",
    title: `Item ${number}`,
    body: "source body",
    author: "contributor",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    head: kind === "pr" ? "head1" : undefined,
    base: kind === "pr" ? "base1" : undefined,
    labels: [],
    comments: [],
    events: [],
    files: kind === "pr" ? [{ path: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new\n", status: "modified" }] : [],
    limitations: [],
    observedAt: "2026-01-03",
  };
  if (kind === "pr") {
    e.files[0].source = {
      before: "old\n",
      after: "new\n",
      baseBlob: blobHash(Buffer.from("old\n")),
      headBlob: blobHash(Buffer.from("new\n")),
      baseMode: "100644",
      headMode: "100644",
    };
    e.coverage = {
      version: 1,
      expectedFiles: e.files.length,
      mergeBase: "base1",
      manifestHash: hash(coverageManifest(e.files)),
    };
  }
  return e;
};
const account = (id = "a"): Account => ({
  id,
  model: "fake-model",
  endpoint: "https://invalid.example/v1/chat/completions",
  keyEnv: "FAKE_KEY",
});
const answer = {
  summary: "Unverified candidate",
  category: "human_review",
  findings: [],
  uncertainty: ["Needs independent confirmation"],
};
const fakeModel = (): Model => vi.fn(async () => ({ value: answer, latencyMs: 100 }));
const sourceFor = (item: Evidence): Source => ({
  inventory: async () => [item.number],
  get: async () => structuredClone(item),
});
async function run(
  store: OperationsStore,
  dir: string,
  source: Source,
  model: Model,
  extra: Record<string, unknown> = {},
) {
  return runOperations({
    store,
    source,
    model,
    accounts: [account()],
    repo: "example/project",
    kind: "pr",
    runId: "run",
    budget: 100,
    output: join(dir, "drafts"),
    ...extra,
  });
}

describe("V5 inventory and isolated storage", () => {
  it("discovers 452 PRs and 1159 issues beyond the old queue; identical checkpoints stay current", async () => {
    const { store } = setup();
    const source: Source = {
      inventory: async (_repo, kind) => Array.from({ length: kind === "pr" ? 452 : 1159 }, (_, i) => i + 1),
      get: async (_repo, kind, n) => evidence(n, kind),
    };
    for (const kind of ["pr", "issue"] as const) await reconcile(store, source, "example/project", kind);
    expect(store.jobs("example/project", "pr")).toHaveLength(452);
    expect(store.jobs("example/project", "issue")).toHaveLength(1159);
    const j = store.jobs("example/project", "pr")[0];
    store.set(j.id, "completed_current");
    await reconcile(store, source, "example/project", "pr");
    expect(store.jobs(j.repo, j.kind)[0].state).toBe("completed_current");
    expect(store.snapshot(j.repo, "issue").totalOpen).toBe(1159);
  }, 30000);
  it("follows >1000-record Link pagination, deduplicates IDs and excludes PRs from issues", async () => {
    let calls = 0;
    const request = vi.fn(async (input: any) => {
      calls++;
      const url = new URL(input);
      const page = Number(url.searchParams.get("page") ?? 1);
      const start = (page - 1) * 100;
      const data = Array.from({ length: page === 12 ? 59 : 100 }, (_, i) => ({
        id: start + i + 1,
        number: start + i + 1,
        state: "open",
        user: { login: "fixture" },
        labels: [],
      }));
      if (page === 2) data.push({ id: 100, number: 100, state: "open", user: { login: "fixture" }, labels: [] });
      return new Response(JSON.stringify(data), {
        headers:
          page < 12
            ? {
                link: `<https://api.github.com/repos/example/project/issues?per_page=100&page=${page + 1}>; rel="next"`,
              }
            : {},
      });
    });
    const client = new OperationsGitHub("fake", request as any);
    expect(await client.inventory("example/project", "issue")).toHaveLength(1159);
    expect(calls).toBe(12);
    expect(request.mock.calls.every((args: any[]) => args[1]?.method === "GET")).toBe(true);
  });
  it.each([401, 403, 429, 500])("fails closed on GitHub HTTP %i", async (status) => {
    const c = new OperationsGitHub("fake", (async () => new Response("{}", { status })) as any);
    await expect(c.inventory("example/project", "pr")).rejects.toThrow("incomplete");
  });
  it("rejects empty intermediate and repeated pages", async () => {
    const c = new OperationsGitHub(
      "fake",
      (async () =>
        new Response("[]", {
          headers: { link: '<https://api.github.com/repos/example/project/issues?page=2>; rel="next"' },
        })) as any,
    );
    await expect(c.inventory("example/project", "issue")).rejects.toThrow("Missing GitHub page");
  });
  it("marks changing discovery unreliable and never infers close from omission", async () => {
    const { store } = setup();
    store.put(evidence(2));
    let n = 0;
    const source: Source = {
      inventory: async () => (++n === 1 ? [1] : [1, 3]),
      get: async (_r, k, num) => evidence(num, k),
    };
    await expect(reconcile(store, source, "example/project", "pr")).rejects.toThrow("changed");
    expect(store.jobs("example/project", "pr").find((j) => j.number === 2)?.state).toBe("pending");
    expect(store.snapshot("example/project", "pr").sync.reliable).toBe(false);
  });
  it("refuses a non-V5 database and preserves a source sentinel", () => {
    const { dir } = setup();
    const sentinel = join(dir, "source-sentinel");
    writeFileSync(sentinel, "untouched");
    const oldFile = join(dir, "legacy.sqlite");
    const legacy = new Database(oldFile);
    legacy.exec("CREATE TABLE review_jobs(x TEXT)");
    legacy.close();
    expect(() => new OperationsStore(oldFile)).toThrow("Refusing non-V5 database");
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
  });
});

describe("V5 race and checkpoint contracts", () => {
  it.each([
    "closed",
    "merged",
    "head",
    "base",
    "comment",
    "body",
  ])("revalidates %s before any paid dispatch", async (change) => {
    const { store, dir } = setup();
    const item = evidence();
    store.put(item);
    const fresh = structuredClone(item);
    if (change === "closed" || change === "merged") fresh.state = change;
    else if (change === "head" || change === "base") fresh[change] = "new";
    else if (change === "comment") fresh.comments.push({ id: 2, body: "changed" });
    else fresh.body = "edited";
    const model = fakeModel();
    await run(store, dir, sourceFor(fresh), model);
    expect(model).not.toHaveBeenCalled();
    expect(
      store.jobs(item.repo, item.kind).find((j) => j.fingerprint === store.jobs(item.repo, item.kind)[0].fingerprint),
    ).toBeDefined();
    expect(store.snapshot(item.repo, item.kind).counts.completed_current ?? 0).toBe(0);
  });
  it.each(["between", "final"])("merge %s batches stops further calls and prevents false current", async (when) => {
    const { store, dir } = setup();
    const item = evidence();
    store.put(item);
    const model = vi.fn(async () => {
      if (when === "between" || model.mock.calls.length === batches(item).length) item.state = "merged";
      return { value: answer };
    });
    await run(store, dir, sourceFor(item), model);
    expect(model).toHaveBeenCalledTimes(when === "between" ? 1 : batches(item).length);
    expect(store.snapshot(item.repo, item.kind).counts.completed_current ?? 0).toBe(0);
    expect(store.snapshot(item.repo, item.kind).externallyHandled).toBeGreaterThan(0);
  });
  it("issue edits and closures supersede independent issue evidence", async () => {
    const { store, dir } = setup();
    const item = evidence(1, "issue");
    store.put(item);
    item.state = "closed";
    const model = fakeModel();
    await run(store, dir, sourceFor(item), model, { kind: "issue" });
    expect(model).not.toHaveBeenCalled();
    expect(store.snapshot(item.repo, "issue").externallyHandled).toBeGreaterThan(0);
  });
  it("preserves every character in a 264k patch and records binary limitations", () => {
    const item = evidence();
    const patch = "x".repeat(264000);
    item.files[0].patch = patch;
    delete item.files[0].source;
    item.files.push({ path: "binary", status: "renamed", previousPath: "old.bin" });
    item.limitations.push("binary patch unavailable");
    const plan = batches(item);
    expect(plan).toHaveLength(13);
    expect(
      plan
        .filter((b) => b.path === "src/a.ts")
        .map((b) => b.text)
        .join(""),
    ).toBe(patch);
    expect(plan.every((b) => b.text.length <= 22000)).toBe(true);
  });
  it("durably resumes a bounded budget with exact checkpoints without duplicate billing", async () => {
    const { store, dir } = setup();
    const item = evidence();
    store.put(item);
    const model = fakeModel();
    await run(store, dir, sourceFor(item), model, { budget: 1 });
    expect(model).toHaveBeenCalledTimes(1);
    await run(store, dir, sourceFor(item), model, { budget: 1 });
    expect(model).toHaveBeenCalledTimes(1);
    await run(store, dir, sourceFor(item), model, { budget: 1, runId: "next" });
    expect(model).toHaveBeenCalledTimes(2);
    expect(store.snapshot(item.repo, "pr").counts.completed_current).toBe(1); // Exact source-backed checkpoints are reused.
    const readonly = new OperationsStore(join(dir, "v5.sqlite"), true);
    try {
      expect(readonly.snapshot(item.repo, "pr").attempts).toHaveLength(2);
    } finally {
      readonly.close();
    }
    expect(
      store.checkpoint(
        store.jobs(item.repo, "pr")[0].id,
        modelFingerprint({ ...account(), model: "different" }),
        batches(item)[0].hash,
      ),
    ).toBeUndefined();
  });
  it.each([401, 402, 403, 429, "timeout", "schema"])("charges failed outbound attempts once on %s", async (failure) => {
    const { store, dir } = setup();
    const item = evidence();
    store.put(item);
    const model = vi.fn(async () => {
      if (failure === "schema") return { value: { merge: true } };
      throw new Error(String(failure));
    });
    await run(store, dir, sourceFor(item), model, { budget: 5 });
    expect(model).toHaveBeenCalledTimes(1);
    const snap = store.snapshot(item.repo, "pr");
    expect(snap.runs[0].spent).toBe(1);
    expect(failure === "timeout" ? snap.counts.paused : snap.counts.failed).toBe(1);
  });
  it("marks uncheckpointed crashed work paused without retrying a charged attempt", () => {
    const { store } = setup();
    store.put(evidence());
    store.startRun("r", 5);
    const job = store.claim("example/project", "pr", "dead")!;
    store.reserve("r", job, "a", "model", 0, "batch", "dead", 3);
    store.db.prepare("UPDATE v5_jobs SET expires=0").run();
    expect(store.claim("example/project", "pr", "new")).toBeUndefined();
    expect(store.snapshot(job.repo, "pr").counts.paused).toBe(1);
    expect(store.snapshot(job.repo, "pr").runs[0].spent).toBe(1);
  });
  it("reserves globally across competing connections, account single flight and mixed kind filters", () => {
    const { store, dir } = setup();
    const other = new OperationsStore(join(dir, "v5.sqlite"));
    stores.push(other);
    store.put(evidence(1));
    store.put(evidence(2));
    store.put(evidence(3, "issue"));
    store.startRun("global", 2);
    const a = store.claim("example/project", "pr", "worker-a")!;
    const b = other.claim("example/project", "pr", "worker-b")!;
    expect(a.kind).toBe("pr");
    expect(b.kind).toBe("pr");
    expect(a.number).not.toBe(b.number);
    expect(store.reserve("global", a, "a", "m", 0, "h", "worker-a", 3)).toBeDefined();
    expect(other.reserve("global", b, "a", "m", 0, "h", "worker-b", 3)).toBeUndefined();
    expect(other.reserve("global", b, "b", "m", 0, "h", "worker-b", 3)).toBeDefined();
    const issue = store.claim("example/project", "issue", "worker-c")!;
    expect(issue.kind).toBe("issue");
    expect(store.reserve("global", issue, "c", "m", 0, "h", "worker-c", 3)).toBeUndefined();
    expect(store.snapshot(a.repo, "pr").runs[0].spent).toBe(2);
  });
  it("runs three fake workers with total budget bounded before dispatch", async () => {
    const { store, dir } = setup();
    const item = evidence();
    for (let n = 1; n <= 8; n++) store.put(evidence(n));
    const source: Source = { inventory: async () => [], get: async (_r, k, n) => evidence(n, k) };
    let active = 0;
    let peak = 0;
    const model = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { value: answer };
    });
    await run(store, dir, source, model, { budget: 5, accounts: [account("a"), account("b"), account("c")] });
    expect(model).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(3);
    expect(store.snapshot(item.repo, "issue").attempts).toHaveLength(0);
  });
  it("rejects injected model action fields and unrelated evidence references", () => {
    const b = batches(evidence())[1];
    expect(() => validateResult({ ...answer, merge: true }, b)).toThrow();
    expect(() =>
      validateResult(
        {
          ...answer,
          findings: [
            {
              file: "other",
              severity: "high",
              explanation: "claim",
              evidenceHash: "fake",
              start: 0,
              end: 1,
              uncertainty: "unverified",
            },
          ],
        },
        b,
      ),
    ).toThrow();
  });
});

describe("V5 CLI executions", () => {
  it("executes dry-run, status and non-TTY dashboard without a paid request", async () => {
    const { store, dir } = setup();
    store.put(evidence());
    const file = join(dir, "v5.sqlite");
    const env = getIsolatedEnv({ PRISM_DATA_DIR: dir });
    for (const mode of ["--status", "--dashboard"]) {
      const output = execFileSync(
        process.execPath,
        [resolve("dist/cli.js"), "review", mode, "--repo", "example/project", "--operations-db", file, "--json"],
        { cwd: dir, env, encoding: "utf8" },
      );
      expect(JSON.parse(output).totalOpen).toBe(1);
    }
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Paid network prohibited"));
    const { operationsCLI } = await import("../review-operations/cli.js");
    const sourceSpy = vi.spyOn(OperationsGitHub.prototype, "inventory").mockResolvedValue([1]);
    vi.spyOn(OperationsGitHub.prototype, "get").mockResolvedValue(evidence());
    vi.spyOn(OperationsGitHub.prototype, "metadata").mockResolvedValue(evidence());
    const old = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "fake";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await operationsCLI({
        allOpen: true,
        dryRun: true,
        type: "pr",
        repo: "example/project",
        operationsDb: file,
        json: true,
      });
      expect(sourceSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.parse(log.mock.calls[0][0]).dryRun).toBe(true);
    } finally {
      if (old === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = old;
    }
    expect(renderSnapshot(store.snapshot("example/project", "pr"))).toContain("N/A");
  });
});

describe("V5 compiled CLI fixture round trip", () => {
  it("executes inventory, paid-boundary fake dispatch, coverage exports, status and dashboard in a disposable directory", () => {
    const dir = temp();
    const preload = join(dir, "fake-network.mjs");
    writeFileSync(
      preload,
      `
import {createHash} from "node:crypto";
const old=Buffer.from("old\\n"),updated=Buffer.from("new\\n");
const blob=b=>createHash("sha1").update("blob "+b.length+"\\0").update(b).digest("hex");
const meta={id:1,number:1,state:"open",title:"Fixture",body:"Fake source",user:{login:"fake"},created_at:"2026-01-01",updated_at:"2026-01-02",head:{sha:"h"},base:{sha:"b"},labels:[],changed_files:1};
globalThis.fetch=async (input,options)=>{
 const url=new URL(input); let data;
 if(options?.method==="POST") { if(url.hostname!=="model.invalid") throw Error("Prohibited paid destination"); data={choices:[{finish_reason:"stop",message:{content:JSON.stringify({summary:"Unverified fixture",category:"human_review",findings:[],uncertainty:["Independent checks required"]})}}]}; }
 else { if(options?.method!=="GET"||url.hostname!=="api.github.com") throw Error("Prohibited network request");
 const p=url.pathname;
 if(p==="/repos/example/project/pulls") data=[meta];
 else if(p==="/repos/example/project/pulls/1") data=meta;
 else if(p.endsWith("/files")) data=[{filename:"src/a.ts",patch:"@@ -1 +1 @@\\n-old\\n+new",status:"modified",sha:blob(updated)}];
 else if(p.includes("/compare/")) data={merge_base_commit:{sha:"b"}};
 else if(p.includes("/git/commits/")) data={sha:p.endsWith("/b")?"b":"h",tree:{sha:p.endsWith("/b")?"old-tree":"new-tree"}};
 else if(p.includes("/git/trees/")) {const before=p.includes("old-");data={truncated:false,tree:p.endsWith("-tree")?[{path:"src",type:"tree",sha:before?"old-src":"new-src",mode:"040000"}]:[{path:"a.ts",type:"blob",sha:blob(before?old:updated),mode:"100644"}]};}
 else if(p.includes("/git/blobs/")) {const bytes=p.endsWith(blob(old))?old:updated;data={sha:blob(bytes),size:bytes.length,encoding:"base64",content:bytes.toString("base64")};}
 else if(p.endsWith("/status")) data={state:"success",statuses:[]};
 else if(p.endsWith("/comments")||p.endsWith("/timeline")||p.endsWith("/reviews")) data=[];
 else throw Error("Unexpected fixture route "+p);
 }
 return new Response(JSON.stringify(data));
};`,
    );
    const cli = resolve("dist/cli.js");
    const env = getIsolatedEnv({
      GITHUB_TOKEN: "fake",
      TEST_API_KEY: "fake",
      PRISM_DATA_DIR: dir,
      PRISM_REVIEW_ACCOUNTS: JSON.stringify([
        { id: "fixture", model: "fake", endpoint: "https://model.invalid/chat", keyEnv: "TEST_API_KEY" },
      ]),
    });
    const execute = (flags: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", preload, cli, "review", "--repo", "example/project", "--type", "pr", "--json", ...flags],
          { cwd: dir, env, encoding: "utf8" },
        ),
      );
    const dry = execute(["--all-open", "--dry-run"]);
    expect(dry.attempts).toHaveLength(0);
    expect(dry.totalOpen).toBe(1);
    const result = execute(["--all-open", "--max-new-calls", "2", "--run-id", "fixture"]);
    expect(result.attempts).toHaveLength(2);
    expect(result.runs[0].spent).toBe(2);
    expect(result.counts.completed_current).toBe(1);
    expect(execute(["--operations", "--status"]).attempts).toHaveLength(2);
    expect(execute(["--dashboard"]).attempts).toHaveLength(2);
  });
  it("keeps reopened items visible and claims only the latest evidence", () => {
    const { store } = setup();
    const item = evidence();
    store.put(item);
    item.state = "closed";
    store.put(item);
    item.state = "open";
    store.put(item);
    expect(store.snapshot(item.repo, "pr").totalOpen).toBe(1);
    expect(store.claim(item.repo, "pr", "worker")?.state).toBe("pending");
  });
});

describe("V5 pagination and terminal negative controls", () => {
  it.each([
    "https://api.github.com/repos/other/project/issues?page=2",
    "https://api.github.com/repos/example/project/issues?page=3",
  ])("rejects unsafe next page %s", async (next) => {
    const client = new OperationsGitHub(
      "fake",
      (async () =>
        new Response(JSON.stringify([{ id: 1, number: 1 }]), { headers: { link: `<${next}>; rel="next"` } })) as any,
    );
    await expect(client.inventory("example/project", "issue")).rejects.toThrow("scope or skipped page");
  });
  it("exits only its TTY dashboard refresh on Ctrl+C and leaves queue ownership intact", async () => {
    const { store, dir } = setup();
    store.put(evidence());
    const job = store.claim("example/project", "pr", "runner");
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { operationsCLI } = await import("../review-operations/cli.js");
    try {
      const promise = operationsCLI({
        dashboard: true,
        type: "pr",
        repo: "example/project",
        operationsDb: join(dir, "v5.sqlite"),
        refresh: "0.1",
      });
      setTimeout(() => process.emit("SIGINT"), 5);
      await promise;
      expect(store.jobs("example/project", "pr").find((j) => j.id === job?.id)?.owner).toBe("runner");
    } finally {
      log.mockRestore();
      write.mockRestore();
      if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });
});
