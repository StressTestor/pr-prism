import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { batches, hash, type Source } from "../review-operations/contracts.js";
import { OperationsGitHub } from "../review-operations/github.js";
import { blobHash, coverageProblems } from "../review-operations/integrity.js";
import { reconcile, runOperations } from "../review-operations/runner.js";
import { OperationsStore } from "../review-operations/store.js";

const directories: string[] = [];
const stores: OperationsStore[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "prism-integrity-"));
  directories.push(dir);
  const store = new OperationsStore(join(dir, "queue.sqlite"));
  stores.push(store);
  return { store, dir };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
interface File {
  path: string;
  previous?: string;
  before: Buffer | null;
  after: Buffer | null;
  status: string;
  patch?: string;
  mode?: string;
}
function fixture(
  files: File[] = [
    {
      path: "a.ts",
      before: Buffer.from("old\n"),
      after: Buffer.from("new\n"),
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
  ],
  options: {
    count?: number;
    corrupt?: boolean;
    truncated?: boolean;
    binary?: boolean;
    mutate?: string;
    comments?: unknown[];
    timeline?: any[];
    linkedMerged?: boolean;
    pageSize?: number;
  } = {},
) {
  const calls: string[] = [];
  let metadataCalls = 0;
  let commentsCalls = 0;
  const blobs = new Map<string, Buffer>();
  for (const f of files) for (const b of [f.before, f.after]) if (b) blobs.set(blobHash(b), b);
  const entries = (before: boolean) =>
    files.flatMap((f) => {
      const b = before ? f.before : f.after;
      return b
        ? [
            {
              path: before ? (f.previous ?? f.path) : f.path,
              type: f.mode === "160000" ? "commit" : "blob",
              sha: blobHash(b),
              mode: f.mode ?? "100644",
            },
          ]
        : [];
    });
  const meta = () => ({
    id: 1,
    number: 1,
    state: "open",
    merged: false,
    title: "Fixture",
    body: "body",
    user: { login: "contributor" },
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
    head: { sha: "head" },
    base: { sha: "base", repo: { full_name: "example/project" } },
    labels: [],
    changed_files: options.count ?? files.length,
  });
  const request = vi.fn(async (input: any, init: any) => {
    expect(init.method).toBe("GET");
    const url = new URL(input);
    const path = url.pathname;
    calls.push(path);
    let data: any;
    const headers: Record<string, string> = {};
    if (/\/(pulls|issues)\/1$/.test(path)) {
      data = meta();
      metadataCalls++;
      if (metadataCalls > 1 && options.mutate) data[options.mutate] = { sha: "changed" };
    } else if (path.endsWith("/files")) {
      const page = Number(url.searchParams.get("page") ?? 1),
        size = options.pageSize ?? files.length;
      if (page * size < files.length) {
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        headers.link = `<${next}>; rel="next"`;
      }
      data = files.slice((page - 1) * size, page * size).map((f) => ({
        filename: f.path,
        previous_filename: f.previous,
        status: f.status,
        patch: f.patch,
        sha: blobHash((f.after ?? f.before)!),
      }));
    } else if (path.includes("/compare/")) data = { merge_base_commit: { sha: "mergebase" } };
    else if (path.includes("/git/commits/")) {
      const sha = path.split("/").at(-1);
      data = { sha, tree: { sha: `${sha}tree` } };
    } else if (path.includes("/git/trees/"))
      data = { tree: entries(path.endsWith("mergebasetree")), truncated: options.truncated ?? false };
    else if (path.includes("/git/blobs/")) {
      const sha = path.split("/").at(-1)!;
      const bytes = blobs.get(sha)!;
      data = {
        sha,
        size: bytes.length,
        encoding: "base64",
        content: (options.corrupt ? Buffer.from("wrong") : bytes).toString("base64"),
      };
    } else if (path.endsWith("/comments")) {
      commentsCalls++;
      data =
        options.mutate === "comments" && commentsCalls > 1 ? [{ id: 4, body: "edited" }] : (options.comments ?? []);
    } else if (path.endsWith("/timeline")) data = options.timeline ?? [];
    else if (path.endsWith("/reviews")) data = [];
    else if (path.endsWith("/pulls/2"))
      data = {
        number: 2,
        state: options.linkedMerged ? "closed" : "open",
        merged: options.linkedMerged ?? false,
        head: { sha: "linked" },
        updated_at: "2026-01-01",
      };
    else if (path.endsWith("/status")) data = { state: "success", statuses: [] };
    else throw new Error(`Unmocked request ${path}`);
    return new Response(JSON.stringify(data), { headers });
  });
  return { source: new OperationsGitHub("fake", request as any), calls, request };
}
const account = { id: "fake", model: "fake", endpoint: "https://model.invalid", keyEnv: "FAKE" };
const answer = { summary: "Unverified", category: "human_review", findings: [], uncertainty: [] };

describe("Source-backed full evidence", () => {
  it("proves complete source despite a missing/truncated patch, including rename, delete and added empty files", async () => {
    const files: File[] = [
      {
        path: "a.ts",
        before: Buffer.from("old\n"),
        after: Buffer.from("new\n"),
        status: "modified",
        patch: "@@ truncated",
      },
      {
        path: "renamed.ts",
        previous: "old.ts",
        before: Buffer.from("same"),
        after: Buffer.from("same"),
        status: "renamed",
      },
      { path: "removed.ts", before: Buffer.from("removed"), after: null, status: "removed" },
      { path: "empty.ts", before: null, after: Buffer.alloc(0), status: "added" },
    ];
    const { source } = fixture(files);
    const e = await source.get("example/project", "pr", 1);
    expect(coverageProblems(e)).toEqual([]);
    expect(e.coverage?.expectedFiles).toBe(4);
    expect(e.files[1].source?.before).toBe("same");
    expect(e.files[2].source?.after).toBeNull();
    const { store, dir } = setup();
    store.put(e);
    const model = vi.fn(async () => ({ value: answer, latencyMs: 10 }));
    await runOperations({
      store,
      source,
      model,
      accounts: [account],
      repo: e.repo,
      kind: e.kind,
      runId: "r",
      budget: 20,
      output: join(dir, "drafts"),
    });
    expect(store.snapshot(e.repo, e.kind).counts.completed_current).toBe(1);
    expect(model).toHaveBeenCalledTimes(batches(e).length);
    const draft = readdirSync(join(dir, "drafts")).find((n) => n.endsWith(".json"))!;
    const saved = JSON.parse(readFileSync(join(dir, "drafts", draft), "utf8"));
    expect(saved.coverage).toHaveLength(batches(e).length);
    expect(saved.limitations).toEqual([]);
  });
  it.each(["count", "checksum", "tree", "binary", "submodule"])("fails closed for %s evidence", async (kind) => {
    const f: File = {
      path: "file",
      before: Buffer.from("old"),
      after: Buffer.from(kind === "binary" ? "\0binary" : "new"),
      status: "modified",
      mode: kind === "submodule" ? "160000" : "100644",
    };
    const { source } = fixture([f], {
      count: kind === "count" ? 2 : undefined,
      corrupt: kind === "checksum",
      truncated: kind === "tree",
    });
    const e = await source.get("example/project", "pr", 1);
    expect(coverageProblems(e).length).toBeGreaterThan(0);
    const { store, dir } = setup();
    store.put(e);
    await runOperations({
      store,
      source,
      model: async () => {
        throw new Error("Incomplete source must not dispatch");
      },
      accounts: [account],
      repo: e.repo,
      kind: e.kind,
      runId: "r",
      budget: 10,
      output: join(dir, "drafts"),
    });
    expect(store.snapshot(e.repo, e.kind).counts.completed_current ?? 0).toBe(0);
    expect(store.snapshot(e.repo, e.kind).requests.reserved).toBe(0);
  });
  it.each(["head", "base", "comments"])("rejects %s changes during source collection", async (mutate) => {
    await expect(fixture(undefined, { mutate }).source.get("example/project", "pr", 1)).rejects.toThrow(
      /moved|changed/,
    );
  });
  it("retains 264k source characters and raw patch checksums across restart without batch loss", async () => {
    const after = "line\n".repeat(52800);
    const { source } = fixture([
      {
        path: "large.ts",
        before: Buffer.from("before"),
        after: Buffer.from(after),
        status: "modified",
        patch: "@@ incomplete",
      },
    ]);
    const e = await source.get("example/project", "pr", 1);
    expect(coverageProblems(e)).toEqual([]);
    const plan = batches(e);
    expect(plan.every((b) => b.text.length <= 22000)).toBe(true);
    const encoded = plan
      .filter((b) => b.path === "large.ts")
      .map((b) => b.text)
      .join("");
    expect(JSON.parse(encoded).source.after).toBe(after);
    const { store, dir } = setup();
    store.put(e);
    const model = vi.fn(async () => ({ value: answer }));
    const run = (id: string, budget: number) =>
      runOperations({
        store,
        source,
        model,
        accounts: [account],
        repo: e.repo,
        kind: e.kind,
        runId: id,
        budget,
        output: join(dir, "drafts"),
      });
    await run("first", 4);
    await run("resume", 100);
    expect(model).toHaveBeenCalledTimes(plan.length);
    expect(store.snapshot(e.repo, e.kind).counts.completed_current).toBe(1);
    const mutated = structuredClone(e);
    mutated.files[0].source!.after += "extra";
    expect(coverageProblems(mutated).length).toBeGreaterThan(0);
  });
});

describe("Incremental reconciliation", () => {
  it("uses overlap, catches open/closed/head/comment changes, and periodically performs a full reconciliation", async () => {
    const { source: remote } = fixture();
    const item = await remote.get("example/project", "pr", 1);
    const { store } = setup();
    let inventory = [1];
    let changed = [1];
    const source: Source = {
      inventory: vi.fn(async () => inventory),
      changes: vi.fn(async () => changed),
      get: vi.fn(async (_r, _k, n) => ({ ...structuredClone(item), number: n })),
    };
    const t = Date.parse("2026-10-28T12:00:00Z");
    await reconcile(store, source, item.repo, item.kind, t);
    expect(source.inventory).toHaveBeenCalledTimes(2);
    item.head = "new-head";
    item.comments = [{ id: 1, body: "maintainer update" }];
    changed = [1, 2];
    inventory = [1, 2];
    await reconcile(store, source, item.repo, item.kind, t + 60000);
    expect(source.inventory).toHaveBeenCalledTimes(2);
    expect(source.changes).toHaveBeenCalledWith(item.repo, item.kind, "2026-10-28T11:55:00.000Z");
    expect(store.snapshot(item.repo, item.kind).historicalStale).toBe(1);
    expect(store.snapshot(item.repo, item.kind).totalOpen).toBe(2);
    item.state = "merged";
    changed = [1];
    await reconcile(store, source, item.repo, item.kind, t + 120000);
    expect(store.snapshot(item.repo, item.kind).externallyHandled).toBe(1);
    item.state = "open";
    await reconcile(store, source, item.repo, item.kind, t + 7 * 3600000);
    expect(source.inventory).toHaveBeenCalledTimes(4);
  });
  it("does not advance the cursor on a failed incremental scan and excludes other item types", async () => {
    const { store } = setup();
    const e = await fixture().source.get("example/project", "pr", 1);
    const source: Source = {
      inventory: async () => [1],
      get: async () => e,
      changes: vi.fn(async () => {
        throw new Error("429");
      }),
    };
    const now = Date.now();
    await reconcile(store, source, e.repo, e.kind, now);
    const previous = store.syncState(e.repo, e.kind);
    await expect(reconcile(store, source, e.repo, e.kind, now + 1000)).rejects.toThrow("429");
    expect(store.syncState(e.repo, e.kind).cursor).toBe(previous.cursor);
    expect(store.jobs(e.repo, "issue")).toEqual([]);
  });
  it("records approvals as external recommendations and still performs its own review", async () => {
    const { store, dir } = setup();
    const e = await fixture().source.get("example/project", "pr", 1);
    e.events.push({ state: "APPROVED", user: { login: "maintainer" }, submitted_at: "2026-01-01" });
    store.put(e);
    const model = vi.fn(async () => ({ value: answer }));
    await runOperations({
      store,
      source: { inventory: async () => [1], get: async () => e },
      model,
      accounts: [account],
      repo: e.repo,
      kind: e.kind,
      runId: "r",
      budget: 20,
      output: join(dir, "drafts"),
    });
    expect(model).toHaveBeenCalled();
    expect(store.snapshot(e.repo, e.kind).counts.completed_current).toBe(1);
    expect(store.snapshot(e.repo, e.kind).recentEvents.some((x: any) => x.kind === "approved_elsewhere")).toBe(true);
  });
  it("rejects overlapping sync writers and keeps manifests stable on read", async () => {
    const { store } = setup();
    expect(store.syncLock("example/project", "pr", "first")).toBe(true);
    const source: Source = {
      inventory: async () => [],
      get: async () => {
        throw new Error("unexpected");
      },
    };
    await expect(reconcile(store, source, "example/project", "pr")).rejects.toThrow("already active");
    expect(hash(store.jobs("example/project", "pr"))).toBe(hash([]));
  });
});

describe("Conversation reconciliation negative controls", () => {
  it("detects a deleted issue comment even when updated_at and incremental inventory stay unchanged", async () => {
    const options = { comments: [{ id: 10, body: "old comment" }] };
    const { source } = fixture(undefined, options);
    const e = await source.get("example/project", "issue", 1);
    const { store } = setup();
    store.put(e); // Selected hydration precedes conversation freshness probes.
    const inventory = vi.spyOn(source, "inventory").mockResolvedValue([1]);
    vi.spyOn(source, "changes").mockResolvedValue([]);
    const now = Date.now();
    await reconcile(store, source, e.repo, e.kind, now);
    options.comments = [];
    await reconcile(store, source, e.repo, e.kind, now + 6 * 60000);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(store.snapshot(e.repo, e.kind).historicalStale).toBe(1);
    const current = store.jobs(e.repo, e.kind).find((j) => j.state === "pending")!;
    expect(JSON.parse(current.evidence).comments).toEqual([]);
  });
  it("invalidates waiting issue evidence when its linked PR merges, without treating that as permission to close", async () => {
    const options = {
      timeline: [
        {
          id: 11,
          event: "cross-referenced",
          source: { issue: { pull_request: { url: "https://api.github.com/repos/example/project/pulls/2" } } },
        },
      ],
      linkedMerged: false,
    };
    const { source } = fixture(undefined, options);
    const e = await source.get("example/project", "issue", 1);
    const { store, dir } = setup();
    store.put(e);
    options.linkedMerged = true;
    const model = vi.fn(async () => ({ value: answer }));
    await runOperations({
      store,
      source,
      model,
      accounts: [account],
      repo: e.repo,
      kind: e.kind,
      runId: "r",
      budget: 2,
      output: join(dir, "drafts"),
    });
    expect(model).not.toHaveBeenCalled();
    expect(store.snapshot(e.repo, e.kind).totalOpen).toBe(1);
    expect(store.snapshot(e.repo, e.kind).historicalStale).toBe(1);
  });
  it("uses conditional reads only for non-collection resources and detects an updated pagination link", async () => {
    const { source } = fixture();
    const e = await source.get("example/project", "pr", 1);
    const probes = e.health!.probes!;
    expect(probes.length).toBeGreaterThan(0);
    const request = vi.fn(async (input: any, options: any) => {
      const route = new URL(input).pathname;
      if (route.endsWith("/pulls/1")) {
        expect(options.headers["If-None-Match"]).toBe('"known"');
        return new Response(null, { status: 304 });
      }
      return new Response("[]", {
        headers: { link: `<https://api.github.com${route}?per_page=100&page=2>; rel="next"` },
      });
    });
    e.health!.probes = probes.slice(0, 2).map((p) => ({ ...p, etag: '"known"' }));
    const probeSource = new OperationsGitHub("fake", request as any);
    expect(await probeSource.probe(e)).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("Changed-file pagination", () => {
  it("accounts for every source across multiple file API pages", async () => {
    const files = Array.from({ length: 205 }, (_, i) => ({
      path: `file-${i}.ts`,
      before: Buffer.from(`before ${i}`),
      after: Buffer.from(`after ${i}`),
      status: "modified",
    }));
    const { source, calls } = fixture(files, { pageSize: 100 });
    const e = await source.get("example/project", "pr", 1);
    expect(e.files).toHaveLength(205);
    expect(calls.filter((p) => p.endsWith("/files"))).toHaveLength(3);
    expect(coverageProblems(e)).toEqual([]);
    expect(
      e.files.every((f) => f.source !== undefined && f.source.headBlob === blobHash(Buffer.from(f.source.after!))),
    ).toBe(true);
  });
});

describe("Pinned object reuse", () => {
  it("reuses immutable checksummed blobs while re-reading mutable PR state and conversation", async () => {
    const { source, calls } = fixture();
    await source.get("example/project", "pr", 1);
    await source.get("example/project", "pr", 1);
    expect(calls.filter((p) => p.includes("/git/blobs/"))).toHaveLength(2);
    expect(calls.filter((p) => p.endsWith("/pulls/1"))).toHaveLength(4);
    expect(calls.filter((p) => p.endsWith("/comments"))).toHaveLength(4);
  });
});
