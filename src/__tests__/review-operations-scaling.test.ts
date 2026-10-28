import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { operationsCLI } from "../review-operations/cli.js";
import type { Kind } from "../review-operations/contracts.js";
import { OperationsGitHub } from "../review-operations/github.js";
import { reconcile, runOperations } from "../review-operations/runner.js";
import { OperationsStore } from "../review-operations/store.js";
import { getIsolatedEnv } from "./cli-test-env.js";

const repo = "example/project";
const dirs: string[] = [];
const stores: OperationsStore[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "prism-scaling-"));
  dirs.push(dir);
  const file = join(dir, "v5.sqlite");
  const store = new OperationsStore(file);
  stores.push(store);
  return { dir, store, file };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function fixture(kind: Kind, size: number) {
  const items = Array.from({ length: size }, (_, i) => ({
    id: i + 1,
    number: i + 1,
    state: "open",
    title: `Fixture ${i + 1}`,
    body: "body",
    user: { login: "fixture" },
    labels: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...(kind === "pr" ? { head: { sha: "head" }, base: { sha: "base" }, changed_files: 0 } : {}),
  }));
  const counts: Record<string, number> = {};
  let comments: unknown[] = [{ id: 1, body: "comment" }];
  let status = 200;
  let missingPage = false;
  const request = vi.fn(async (input: any, options: any) => {
    expect(options.method).toBe("GET");
    const url = new URL(input);
    expect(url.origin).toBe("https://api.github.com");
    const key = url.pathname.replace(/\/\d+/, "/:number");
    counts[key] = (counts[key] ?? 0) + 1;
    if (status !== 200)
      return new Response("{}", {
        status,
        headers: { "retry-after": "120", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 180) },
      });
    const root = `/repos/${repo}`;
    const listing = `${root}/${kind === "pr" ? "pulls" : "issues"}`;
    let data: any;
    let headers = {};
    if (url.pathname === listing) {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (missingPage && page === 2) throw new Error("interrupted listing");
      let records = items.filter((i) => url.searchParams.get("state") === "all" || i.state === "open");
      if (url.searchParams.get("sort") === "updated")
        records = [...records].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      if (url.searchParams.has("since"))
        records = records.filter((i) => i.updated_at >= url.searchParams.get("since")!);
      data = records.slice((page - 1) * 100, page * 100);
      if (page * 100 < records.length) {
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        headers = { link: `<${next}>; rel="next"` };
      }
    } else if (url.pathname === `${listing}/1`) data = items[0];
    else if (url.pathname.endsWith("/comments")) data = comments;
    else if (/\/(timeline|reviews|files)$/.test(url.pathname)) data = [];
    else if (url.pathname.includes("/compare/")) data = { merge_base_commit: { sha: "base" } };
    else if (url.pathname.endsWith("/status")) data = { state: "success", statuses: [] };
    else throw new Error(`Unexpected route ${url}`);
    return new Response(JSON.stringify(data), { headers });
  });
  const source = new OperationsGitHub("fixture", request as any);
  return {
    source,
    request,
    items,
    counts,
    total: () => request.mock.calls.length,
    deleteComment: () => {
      comments = [];
    },
    limit: (n: number) => {
      status = n;
    },
    interrupt: () => {
      missingPage = true;
    },
  };
}
for (const [kind, size] of [
  ["issue", 1158],
  ["pr", 451],
] as const) {
  it(`measures ${size} ${kind}s: cold CLI dry-run, warm, incremental, selected full evidence and deletion`, async () => {
    const { store, dir, file } = setup();
    const f = fixture(kind, size);
    vi.spyOn(globalThis, "fetch").mockImplementation(f.request as any);
    vi.stubEnv("GITHUB_TOKEN", "fixture");
    vi.stubEnv("PRISM_REVIEW_ACCOUNTS", "invalid JSON; dry-run must ignore");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = Date.now();
    await operationsCLI({ repo, type: kind, allOpen: true, dryRun: true, operationsDb: file, json: true });
    const cold = f.total();
    expect(cold).toBe(2 * Math.ceil(size / 100));
    expect(store.snapshot(repo, kind).inventoryKnown).toBe(size);
    expect(store.snapshot(repo, kind).requests.reserved).toBe(0);
    expect(store.snapshot(repo, kind).counts.completed_current ?? 0).toBe(0);
    // Fresh client simulates a new CLI invocation; only feed pages, no per-item evidence.
    await reconcile(store, f.source, repo, kind, now + 1000);
    const warm = f.total() - cold;
    expect(warm).toBe(1);
    f.items[0].body = "edited body";
    f.items[0].updated_at = new Date(now + 2000).toISOString();
    await reconcile(store, f.source, repo, kind, now + 3000);
    const incremental = f.total() - cold - warm;
    expect(incremental).toBe(1);
    expect(f.request.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/comments"))).toBe(false);
    const beforeSelected = f.total();
    const selected = await f.source.get(repo, kind, 1);
    const selectedCalls = f.total() - beforeSelected;
    expect(selected.inventoryOnly).toBeUndefined();
    expect(selected.comments).toHaveLength(1);
    store.put(selected);
    const model = vi.fn(async () => ({
      value: { summary: "fixture", category: "human_review", findings: [], uncertainty: [] },
    }));
    await runOperations({
      store,
      source: f.source,
      model,
      accounts: [{ id: "fixture", model: "fixture", endpoint: "https://model.invalid", keyEnv: "FAKE" }],
      repo,
      kind,
      runId: "selected",
      budget: 1,
      output: join(dir, "drafts"),
    });
    expect(model).toHaveBeenCalledTimes(1);
    expect(store.snapshot(repo, kind).counts.completed_current).toBe(1);
    f.deleteComment();
    await reconcile(store, f.source, repo, kind, now + 6 * 60000);
    expect(store.snapshot(repo, kind).counts.completed_current ?? 0).toBe(0);
    expect(store.snapshot(repo, kind).inventoryKnown).toBe(size);
    expect(store.snapshot(repo, kind).historicalStale).toBeGreaterThan(0);
    const beforeChangedHydration = f.total();
    expect((await f.source.get(repo, kind, 1)).comments).toEqual([]);
    expect(f.total() - beforeChangedHydration).toBe(selectedCalls);
    log.mockRestore();
    console.log(
      JSON.stringify({ scenario: kind, size, cold, warm, incremental, selectedCalls, paidDryRun: 0, routes: f.counts }),
    );
  });
  it(`tracks ${kind} closure, reopening and metadata drift without full hydration`, async () => {
    const { store } = setup();
    const f = fixture(kind, size);
    const now = Date.now();
    await reconcile(store, f.source, repo, kind, now);
    for (const [offset, state] of [
      [1000, "closed"],
      [3000, "open"],
    ] as const) {
      f.items[0].state = state;
      f.items[0].updated_at = new Date(now + offset).toISOString();
      await reconcile(store, f.source, repo, kind, now + offset + 1000);
      expect(store.snapshot(repo, kind).totalOpen).toBe(size - (state === "closed" ? 1 : 0));
    }
    if (kind === "pr") f.items[0].head!.sha = "new-head";
    else f.items[0].body = "new-body";
    f.items[0].updated_at = new Date(now + 5000).toISOString();
    await reconcile(store, f.source, repo, kind, now + 6000);
    expect(store.snapshot(repo, kind).inventoryKnown).toBe(size);
    expect(store.snapshot(repo, kind).requests.reserved).toBe(0);
    expect(f.request.mock.calls.every(([url]) => !new URL(url).pathname.match(/\/\d+$/))).toBe(true);
  });
  it(`does not repeatedly fetch already closed historical ${kind} records on full scans`, async () => {
    const { store } = setup();
    const f = fixture(kind, size);
    const now = Date.now();
    await reconcile(store, f.source, repo, kind, now);
    f.items[0].state = "closed";
    f.items[0].updated_at = new Date(now + 1000).toISOString();
    await reconcile(store, f.source, repo, kind, now + 2000);
    const before = f.total();
    await reconcile(store, f.source, repo, kind, now + 7 * 3600000);
    expect(f.total() - before).toBe(2 * Math.ceil((size - 1) / 100));
    expect(store.snapshot(repo, kind).totalOpen).toBe(size - 1);
  });
  it(`does not advance cursor after interrupted ${kind} pages`, async () => {
    const { store } = setup();
    const f = fixture(kind, size);
    await reconcile(store, f.source, repo, kind);
    const prior = store.syncState(repo, kind);
    f.interrupt();
    await expect(reconcile(store, f.source, repo, kind, Date.now() + 7 * 3600000)).rejects.toThrow("interrupted");
    expect(store.syncState(repo, kind).cursor).toBe(prior.cursor);
    expect(store.syncState(repo, kind).reliable).toBe(false);
    expect(store.snapshot(repo, kind).requests.reserved).toBe(0);
  });
}
it.each([403, 429])("persists reset-aware %i cooldown across new clients without retrying HTTP", async (status) => {
  const { store } = setup();
  const f = fixture("issue", 1158);
  const now = Date.now();
  await reconcile(store, f.source, repo, "issue", now);
  const cursor = store.syncState(repo, "issue").cursor;
  f.limit(status);
  await expect(reconcile(store, f.source, repo, "issue", now + 1000)).rejects.toThrow(/cooldown/);
  const calls = f.total();
  await expect(
    reconcile(store, new OperationsGitHub("fixture", f.request as any), repo, "issue", now + 2000),
  ).rejects.toThrow(/cooldown/);
  expect(f.total()).toBe(calls);
  expect(store.syncState(repo, "issue").cursor).toBe(cursor);
  expect(store.syncState(repo, "issue").retryAt).toBeGreaterThan(now + 120000);
});
it("keeps V4 queue status, requires explicit V5 inspection and rejects mixed modes offline", () => {
  const { dir, file } = setup();
  const cli = resolve("dist/cli.js"),
    env = getIsolatedEnv({ HOME: dir, PRISM_DATA_DIR: dir });
  const invoke = (flags: string[]) =>
    execFileSync(process.execPath, [cli, "review", ...flags], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  expect(() => invoke(["--status"])).toThrow(/queue-db.*operations/);
  const old = JSON.parse(invoke(["--queue-db", join(dir, "v4.sqlite"), "--status", "--json"]));
  expect(old.stats.total).toBe(0);
  const current = JSON.parse(invoke(["--operations", "--status", "--repo", repo, "--operations-db", file, "--json"]));
  expect(current.totalOpen).toBe(0);
  for (const flags of [
    ["--status", "--all-open"],
    ["--recover", "--status"],
    ["--status", "--queue-db", join(dir, "v4.sqlite")],
    ["--status", "--max-new-calls", "1"],
    ["--acknowledge-uncertain", "x"],
  ])
    expect(() => invoke(["--operations", "--repo", repo, ...flags])).toThrow();
});

it("bounds periodic probes and durably rotates without starving later evidence", async () => {
  const { store } = setup();
  const f = fixture("issue", 1158);
  const e = await f.source.get(repo, "issue", 1);
  for (let n = 1; n <= 251; n++) store.put({ ...e, number: n });
  const probe = vi.fn(async (_e: import("../review-operations/contracts.js").Evidence) => false);
  const source = {
    inventory: async () => Array.from({ length: 251 }, (_, i) => i + 1),
    changes: async () => [],
    metadata: async (_r: string, _k: Kind, n: number) => ({
      ...e,
      number: n,
      inventoryOnly: true as const,
      health: { ...e.health!, metadataHash: e.health!.metadataHash },
    }),
    get: async () => {
      throw Error("no hydration during scan");
    },
    probe,
  };
  const now = Date.now();
  for (let i = 0; i < 3; i++) await reconcile(store, source, repo, "issue", now + i * 6 * 60000);
  expect(probe).toHaveBeenCalledTimes(300);
  expect(new Set(probe.mock.calls.map(([item]) => item.number)).size).toBe(251);
  expect(store.syncState(repo, "issue").probeAfter).toBe(49);
});
