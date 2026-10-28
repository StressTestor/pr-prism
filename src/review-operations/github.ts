import { type Evidence, fingerprint, hash, type Kind, type Source } from "./contracts.js";
import { blobHash, coverageManifest } from "./integrity.js";

// This transport exposes only GET. Pagination follows Link, not item-count guesses.
export class OperationsGitHub implements Source {
  health: Evidence["health"];
  private immutable = new Map<string, { data: any; next: string | null; etag?: string | null; size: number }>();
  private immutableBytes = 0;
  private metadataCache = new Map<string, Evidence>();
  private cooldownUntil = 0;
  constructor(
    private token: string,
    private request: typeof fetch = fetch,
    private api = "https://api.github.com",
  ) {}
  private async getJSON(
    route: string,
    etag?: string,
  ): Promise<{ data: any; next: string | null; etag?: string | null; notModified?: boolean }> {
    const url = new URL(route, this.api);
    if (url.origin !== new URL(this.api).origin || !url.pathname.startsWith("/repos/"))
      throw new Error("Untrusted GitHub pagination URL");
    const cacheable = /\/git\/(commits|trees|blobs)\/[0-9a-f]{40}$/.test(url.pathname) && !etag;
    const cached = cacheable ? this.immutable.get(url.href) : undefined;
    if (cached) return cached;
    if (Date.now() < this.cooldownUntil)
      throw new Error(`GitHub cooldown until ${new Date(this.cooldownUntil).toISOString()}; inventory is incomplete`);
    const response = await this.request(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(etag ? { "If-None-Match": etag } : {}),
      },
      signal: AbortSignal.timeout(30000),
    });
    this.health = {
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset"),
    };
    if (response.status === 304 && etag) return { data: null, next: null, notModified: true, etag };
    if (response.status === 403 || response.status === 429) {
      const retry = response.headers.get("retry-after");
      const delay = retry
        ? Number.isFinite(Number(retry))
          ? Date.now() + Number(retry) * 1000
          : Date.parse(retry)
        : 0;
      this.cooldownUntil = Math.max(Date.now() + 60000, Number(this.health.reset) * 1000 || 0, delay || 0);
      throw Object.assign(
        new Error(
          `GitHub rate/permission limit (${response.status}); cooldown until ${new Date(this.cooldownUntil).toISOString()}; inventory is incomplete`,
        ),
        { retryAt: this.cooldownUntil },
      );
    }
    if (!response.ok) throw new Error(`GitHub read failed (${response.status}); inventory is incomplete`);
    const next = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1] ?? null;
    const result = { data: await response.json(), next, etag: response.headers.get("etag") };
    if (cacheable) {
      const size = Buffer.byteLength(JSON.stringify(result));
      if (size <= 2 * 1024 * 1024) {
        while (this.immutable.size && (this.immutableBytes + size > 64 * 1024 * 1024 || this.immutable.size >= 512)) {
          const key = this.immutable.keys().next().value!;
          this.immutableBytes -= this.immutable.get(key)!.size;
          this.immutable.delete(key);
        }
        this.immutable.set(url.href, { ...result, size });
        this.immutableBytes += size;
      }
    }
    return result;
  }
  private async pages(route: string, stopBefore?: string, read = this.getJSON.bind(this)): Promise<any[]> {
    const expectedPath = new URL(route, this.api).pathname;
    let expectedPage = 1;
    const result: any[] = [];
    const seen = new Set<string>();
    let next: string | null = route;
    while (next) {
      if (seen.has(next)) throw new Error("Repeated GitHub pagination cursor");
      const url = new URL(next, this.api);
      if (url.pathname !== expectedPath || Number(url.searchParams.get("page") ?? 1) !== expectedPage++)
        throw new Error("Invalid GitHub page scope or skipped page");
      seen.add(next);
      const page = await read(next);
      if (!Array.isArray(page.data) || (page.next && page.data.length === 0)) throw new Error("Missing GitHub page");
      result.push(...page.data);
      next = stopBefore && page.data.some((i: any) => i.updated_at < stopBefore) ? null : page.next;
    }
    const unique = new Map<string, any>();
    for (const item of result) {
      const identity = item.id ?? item.filename ?? item.node_id ?? item.sha ?? hash(item);
      if (identity === undefined) throw new Error("GitHub record missing identity");
      const old = unique.get(String(identity));
      if (old && fingerprint(old) !== fingerprint(item)) throw new Error("Inconsistent duplicate GitHub record");
      unique.set(String(identity), item);
    }
    return [...unique.values()];
  }
  private root(repo: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Expected owner/repo");
    return `/repos/${repo}`;
  }
  private remember(repo: string, kind: Kind, item: any): Evidence {
    if (!Number.isSafeInteger(item.number) || item.number < 1 || !["open", "closed"].includes(item.state))
      throw new Error("Invalid inventory metadata");
    const evidence: Evidence = {
      repo,
      kind,
      number: item.number,
      state: item.merged || item.merged_at ? "merged" : item.state,
      title: item.title,
      body: item.body ?? "",
      author: item.user.login,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      head: item.head?.sha,
      base: item.base?.sha,
      draft: item.draft,
      labels: item.labels.map((l: any) => l.name),
      comments: [],
      events: [],
      files: [],
      limitations: ["Inventory only; full evidence not inspected"],
      inventoryOnly: true,
      observedAt: new Date().toISOString(),
      health: { ...this.health!, metadataHash: this.metadataHash(item) },
    };
    this.metadataCache.set(`${repo}:${kind}:${item.number}`, evidence);
    return evidence;
  }
  private metadataHash(item: any) {
    // Listing and detail responses have different fields. Compare only shared mutable identity.
    return hash([
      item.number,
      item.state,
      item.title,
      item.body ?? "",
      item.updated_at,
      item.head?.sha,
      item.base?.sha,
      item.draft,
      item.labels.map((l: any) => l.name),
    ]);
  }
  async metadata(repo: string, kind: Kind, number: number): Promise<Evidence> {
    const cached = this.metadataCache.get(`${repo}:${kind}:${number}`);
    if (cached) return structuredClone(cached);
    const item = (await this.getJSON(`${this.root(repo)}/${kind === "pr" ? "pulls" : "issues"}/${number}`)).data;
    if (item.number !== number) throw new Error("GitHub metadata identity mismatch");
    return this.remember(repo, kind, item);
  }
  async inventory(repo: string, kind: Kind): Promise<number[]> {
    this.metadataCache.clear();
    const items = await this.pages(
      `${this.root(repo)}/${kind === "pr" ? "pulls" : "issues"}?state=open&sort=created&direction=asc&per_page=100`,
    );
    for (const item of items.filter((i) => kind === "pr" || !i.pull_request)) this.remember(repo, kind, item);
    return items
      .filter((i) => kind === "pr" || !i.pull_request)
      .map((i) => i.number)
      .sort((a, b) => a - b);
  }
  async changes(repo: string, kind: Kind, since: string): Promise<number[]> {
    this.metadataCache.clear();
    const route =
      kind === "issue"
        ? `${this.root(repo)}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(since)}&per_page=100`
        : `${this.root(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
    const items = await this.pages(route, kind === "pr" ? since : undefined);
    for (const item of items.filter((i) => kind === "pr" || !i.pull_request)) this.remember(repo, kind, item);
    return [
      ...new Set(items.filter((i) => (kind === "pr" || !i.pull_request) && i.updated_at >= since).map((i) => i.number)),
    ].sort((a, b) => a - b);
  }
  // Resolve paths through pinned non-recursive Git trees: contents endpoints can follow symlinks.
  private async sources(
    root: string,
    beforeCommit: string,
    afterCommit: string,
    files: Evidence["files"],
    raw: any[],
    limitations: string[],
  ) {
    const trees = new Map<string, any>();
    const commits = new Map<string, string>();
    const tree = async (sha: string) => {
      if (!trees.has(sha)) {
        const data = (await this.getJSON(`${root}/git/trees/${sha}`)).data;
        if (data.truncated || !Array.isArray(data.tree)) throw new Error("Incomplete Git tree");
        trees.set(sha, data.tree);
      }
      return trees.get(sha) as any[];
    };
    const entry = async (commit: string, path: string) => {
      if (!commits.has(commit)) {
        const data = (await this.getJSON(`${root}/git/commits/${commit}`)).data;
        if (data.sha !== commit || !data.tree?.sha) throw new Error("Commit/tree identity mismatch");
        commits.set(commit, data.tree.sha);
      }
      let sha = commits.get(commit)!;
      const parts = path.split("/");
      if (parts.some((p) => !p || p === "." || p === "..")) throw new Error("Invalid source path");
      for (let i = 0; i < parts.length; i++) {
        const found = (await tree(sha)).find((e) => e.path === parts[i]);
        if (!found) return null;
        if (i === parts.length - 1) return found;
        if (found.type !== "tree") throw new Error("Non-tree source ancestor");
        sha = found.sha;
      }
      return null;
    };
    const text = async (e: any) => {
      if (!e) return null;
      if (e.type !== "blob" || !["100644", "100755", "120000"].includes(e.mode))
        throw new Error("Non-text object/submodule");
      const blob = (await this.getJSON(`${root}/git/blobs/${e.sha}`)).data;
      if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error("Missing blob content");
      const bytes = Buffer.from(blob.content, "base64");
      if (bytes.length !== blob.size || blob.sha !== e.sha || blobHash(bytes) !== e.sha)
        throw new Error("Blob checksum mismatch");
      const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (bytes.includes(0) || !Buffer.from(value).equals(bytes)) throw new Error("Binary or non-UTF8 content");
      return value;
    };
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const before = file.status === "added" ? null : await entry(beforeCommit, file.previousPath ?? file.path);
        const after = file.status === "removed" ? null : await entry(afterCommit, file.path);
        if (
          (after && raw[i].sha !== after.sha) ||
          (file.status === "removed" && before && raw[i].sha !== before.sha) ||
          (file.status !== "added" && !before) ||
          (file.status !== "removed" && !after)
        )
          throw new Error("File metadata/source identity mismatch");
        file.source = {
          before: await text(before),
          after: await text(after),
          baseBlob: before?.sha ?? null,
          headBlob: after?.sha ?? null,
          baseMode: before?.mode ?? null,
          headMode: after?.mode ?? null,
        };
      } catch (error) {
        limitations.push(
          `Source unavailable for ${file.path}: ${error instanceof Error ? error.message : "unverified"}`,
        );
      }
    }
  }
  async probe(evidence: Evidence): Promise<boolean> {
    if (!evidence.health?.probes?.length) return true;
    for (const previous of evidence.health.probes) {
      if (!new URL(previous.route, this.api).pathname.startsWith(`${this.root(evidence.repo)}/`))
        throw new Error("Invalid probe scope");
      // Collection pages are fetched in full to catch deleted entries and changed pagination links.
      const collection = /\/(comments|timeline|reviews|files)(\?|$)/.test(previous.route);
      const response = await this.getJSON(previous.route, collection ? undefined : (previous.etag ?? undefined));
      if (!response.notModified && hash({ data: response.data, next: response.next }) !== previous.digest) return true;
    }
    return false;
  }
  async get(repo: string, kind: Kind, number: number): Promise<Evidence> {
    const probes = new Map<string, { route: string; digest: string; etag?: string | null }>();
    const read = async (route: string) => {
      const response = await this.getJSON(route);
      if (!/\/(git|compare)\//.test(new URL(route, this.api).pathname))
        probes.set(route, { route, digest: hash({ data: response.data, next: response.next }), etag: response.etag });
      return response;
    };
    const pages = (route: string) => this.pages(route, undefined, read);
    const root = this.root(repo);
    const route = `${root}/${kind === "pr" ? "pulls" : "issues"}/${number}`;
    const first = (await read(route)).data;
    if (first.number !== number || (first.base?.repo?.full_name && first.base.repo.full_name !== repo))
      throw new Error("GitHub evidence identity mismatch");
    if (first.state !== "open")
      return {
        repo,
        kind,
        number,
        state: first.merged ? "merged" : "closed",
        title: first.title,
        body: first.body ?? "",
        author: first.user.login,
        createdAt: first.created_at,
        updatedAt: first.updated_at,
        head: first.head?.sha,
        base: first.base?.sha,
        draft: first.draft,
        labels: first.labels.map((l: any) => l.name),
        comments: [],
        events: [
          {
            event: first.merged ? "merged" : "closed",
            actor: first.merged_by ?? first.closed_by,
            created_at: first.closed_at,
          },
        ],
        files: [],
        limitations: [],
        observedAt: new Date().toISOString(),
        health: { ...this.health!, metadataHash: this.metadataHash(first), probes: [...probes.values()] },
      };
    const comments = await pages(`${root}/issues/${number}/comments?per_page=100`);
    const events = await pages(`${root}/issues/${number}/timeline?per_page=100`);
    const rawTimeline = structuredClone(events);
    const limitations: string[] = [];
    let files: Evidence["files"] = [];
    let coverage: Evidence["coverage"];
    if (kind === "pr") {
      const raw = await pages(`${route}/files?per_page=100`);
      files = raw.map((f) => ({
        path: f.filename,
        previousPath: f.previous_filename,
        patch: f.patch,
        status: f.status,
        objectSha: f.sha,
      }));
      if (raw.length !== first.changed_files)
        limitations.push("Changed-file inventory incomplete (GitHub file API limit or moving snapshot)");
      const comparison = (await this.getJSON(`${root}/compare/${first.base.sha}...${first.head.sha}`)).data;
      if (!comparison.merge_base_commit?.sha) throw new Error("Missing PR merge base");
      await this.sources(root, comparison.merge_base_commit.sha, first.head.sha, files, raw, limitations);
      coverage = {
        version: 1,
        expectedFiles: first.changed_files,
        mergeBase: comparison.merge_base_commit.sha,
        manifestHash: hash(coverageManifest(files)),
      };
      events.push(...(await pages(`${route}/reviews?per_page=100`)));
      const checks = await read(`${root}/commits/${first.head.sha}/status`);
      events.push({ event: "CI_changed", state: checks.data.state, statuses: checks.data.statuses });
    } else {
      // Linked fixes remain candidate evidence: resolving semantics require independent verification.
      for (const event of events) {
        const issue = event.source?.issue;
        if (issue?.pull_request?.url?.startsWith(`${this.api}${root}/pulls/`)) {
          const linked = (await read(issue.pull_request.url)).data;
          event.linkedFix = {
            number: linked.number,
            state: linked.state,
            merged: linked.merged,
            head: linked.head?.sha,
            updatedAt: linked.updated_at,
          };
        }
      }
    }
    const finalComments = await pages(`${root}/issues/${number}/comments?per_page=100`);
    const finalTimeline = await pages(`${root}/issues/${number}/timeline?per_page=100`);
    if (hash(comments) !== hash(finalComments) || hash(rawTimeline) !== hash(finalTimeline))
      throw new Error("Conversation changed during evidence collection");
    const last = (await read(route)).data;
    if (JSON.stringify(first) !== JSON.stringify(last))
      throw new Error("GitHub metadata moved during evidence fetch; reconcile again");
    return {
      repo,
      kind,
      number,
      state: first.merged ? "merged" : first.state,
      title: first.title,
      body: first.body ?? "",
      author: first.user.login,
      createdAt: first.created_at,
      updatedAt: first.updated_at,
      head: first.head?.sha,
      base: first.base?.sha,
      draft: first.draft,
      labels: first.labels.map((l: any) => l.name),
      comments,
      events,
      files,
      coverage,
      limitations,
      observedAt: new Date().toISOString(),
      health: { ...this.health!, metadataHash: this.metadataHash(first), probes: [...probes.values()] },
    };
  }
}
