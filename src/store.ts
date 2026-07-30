import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  type CompiledIncidentWindow,
  compileIncidentWindows,
  type IncidentWindow,
  isIncidentClosed,
} from "./incident.js";
import type { StoreItem } from "./types.js";

/** Named so the constructor tail stays one argument as more knobs arrive,
 * rather than growing another positional parameter each time. */
export interface VectorStoreOptions {
  incidentWindows?: readonly IncidentWindow[];
}

/**
 * Bumped when the on-disk vector representation changes. Stores written under
 * an older value are refused by search() rather than silently answered with
 * wrong similarities, because a raw vector and a normalised one are
 * indistinguishable once written.
 */
export const VECTOR_GEOMETRY_VERSION = "1";

/**
 * vec0 has no cosine mode here: the table is declared without a distance
 * metric, so sqlite-vec returns L2. For unit vectors L2 and cosine are the same
 * ordering and convert exactly, which is why vectors are normalised on write
 * and similarity is derived rather than assumed.
 */
function toUnitVector(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const mag = Math.sqrt(sum);
  if (mag === 0 || Math.abs(mag - 1) < 1e-6) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / mag;
  return out;
}

/** L2 between unit vectors is sqrt(2 - 2cos), so cos = 1 - d^2 / 2. */
export function l2DistanceToCosine(distance: number): number {
  return 1 - (distance * distance) / 2;
}

export class VectorStore {
  private db: Database.Database;
  private incidentWindows: readonly CompiledIncidentWindow[];
  private dimensions: number;
  private embeddingModel?: string;

  constructor(
    dbPath?: string,
    dimensions?: number,
    embeddingModel?: string,
    /** Repository-wide events that closed items for non-quality reasons.
     * Applied at read time so a corrected window needs no rescan. */
    options: VectorStoreOptions = {},
  ) {
    // Compiled here rather than per item: a malformed window throws now instead
    // of quietly matching nothing on every read.
    this.incidentWindows = compileIncidentWindows(options.incidentWindows ?? []);
    const p = dbPath || resolve(process.cwd(), "data", "prism.db");
    mkdirSync(resolve(p, ".."), { recursive: true });
    this.db = new Database(p);
    this.db.pragma("busy_timeout = 5000");
    this.dimensions = dimensions ?? 0;
    this.embeddingModel = embeddingModel;
    this.init();
  }

  private init() {
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");

    // Metadata table — must exist before any checks
    this.db.exec("CREATE TABLE IF NOT EXISTS prism_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    // Decide the store's vector geometry once, at open. An unmarked store with
    // vectors already in it predates normalisation, so it is recorded as 0 and
    // search refuses it until backfilled; an unmarked empty store is simply new.
    if (this.getMeta("vector_geometry_version") === undefined) {
      const hasVectors =
        (
          this.db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='vec_items'").get() as {
            c: number;
          }
        ).c > 0
          ? (this.db.prepare("SELECT COUNT(*) as c FROM vec_items").get() as { c: number }).c > 0
          : false;
      this.setMeta("vector_geometry_version", hasVectors ? "0" : VECTOR_GEOMETRY_VERSION);
    }

    // Validate dimensions if vec_items already exists
    const tableCheck = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_items'")
      .get() as any;

    if (tableCheck && this.dimensions > 0) {
      const row = this.db.prepare("SELECT embedding FROM vec_items LIMIT 1").get() as any;
      if (row) {
        const existingDim = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        ).length;
        if (existingDim !== this.dimensions) {
          this.db.close();
          throw new Error(
            `dimension mismatch: database has ${existingDim}-dim embeddings but provider uses ${this.dimensions}. ` +
              `run \`prism re-embed\` to re-embed with current provider, or \`prism reset\` to start fresh.`,
          );
        }
      }
    } else if (tableCheck && this.dimensions === 0) {
      // Read-only mode: detect dimensions from existing data
      const row = this.db.prepare("SELECT embedding FROM vec_items LIMIT 1").get() as any;
      if (row) {
        this.dimensions = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        ).length;
      }
    }

    // Validate embedding model if one was specified
    if (this.embeddingModel) {
      const storedModel = this.getMeta("embedding_model");
      if (storedModel && storedModel !== this.embeddingModel) {
        this.db.close();
        throw new Error(
          `embedding model changed from ${storedModel} to ${this.embeddingModel}. ` +
            `run \`prism re-embed\` to re-embed with current provider, or \`prism reset\` to start fresh.`,
        );
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        title TEXT NOT NULL,
        body_snippet TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diffs (
        number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        patch_text TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (number, repo)
      );

      CREATE TABLE IF NOT EXISTS reviews (
        number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'pr',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        summary TEXT NOT NULL,
        concerns_json TEXT NOT NULL DEFAULT '[]',
        recommendation TEXT NOT NULL,
        confidence REAL NOT NULL,
        reviewed_at TEXT NOT NULL,
        PRIMARY KEY (number, repo)
      );

      CREATE INDEX IF NOT EXISTS idx_items_repo ON items(repo);
      CREATE INDEX IF NOT EXISTS idx_items_number ON items(number, repo);
      CREATE INDEX IF NOT EXISTS idx_reviews_repo ON reviews(repo);

      CREATE TABLE IF NOT EXISTS author_cache (
        author TEXT NOT NULL,
        repo TEXT NOT NULL,
        merge_count INTEGER NOT NULL,
        cached_at TEXT NOT NULL,
        PRIMARY KEY (author, repo)
      );
    `);

    // Only create vec_items if we know the dimensions
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}]
        );
      `);
    }
  }

  /** One place that decides the incident flag, so the two hydration sites
   * cannot drift apart. */
  private incidentFlag(metadata: { state?: unknown; closedAt?: unknown }): boolean {
    return isIncidentClosed(
      { state: String(metadata.state ?? ""), closedAt: (metadata.closedAt as string) ?? null },
      this.incidentWindows,
    );
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM prism_meta WHERE key = ?").get(key) as any;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO prism_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  dropVecItems(): void {
    this.db.exec("DROP TABLE IF EXISTS vec_items");
  }

  initVecItems(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}]
      )
    `);
  }

  upsertEmbeddingOnly(id: string, embedding: Float32Array): void {
    const unit = toUnitVector(embedding);
    this.db.prepare("DELETE FROM vec_items WHERE id = ?").run(id);
    this.db
      .prepare("INSERT INTO vec_items (id, embedding) VALUES (?, ?)")
      .run(id, Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength));
  }

  upsert(item: StoreItem): void {
    const id = `${item.repo}:${item.type}:${item.number}`;

    this.db
      .prepare(`
      INSERT INTO items (id, type, number, repo, title, body_snippet, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        body_snippet = excluded.body_snippet,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `)
      .run(
        id,
        item.type,
        item.number,
        item.repo,
        item.title,
        item.bodySnippet,
        JSON.stringify(item.metadata),
        item.createdAt,
        item.updatedAt,
      );

    this.db.prepare("DELETE FROM vec_items WHERE id = ?").run(id);
    const unit = toUnitVector(item.embedding);
    this.db
      .prepare("INSERT INTO vec_items (id, embedding) VALUES (?, ?)")
      .run(id, Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength));
  }

  /**
   * Refuse to answer from a store written under an older geometry. Checked on
   * read, not on write: the dangerous case is a database created before this
   * change being opened by a binary that assumes the new one, which no
   * insert-time assertion can see.
   */
  private assertVectorGeometry(): void {
    const stored = this.getMeta("vector_geometry_version");
    if (stored !== VECTOR_GEOMETRY_VERSION) {
      throw new Error(
        `this database was written with vector geometry ${stored ?? "0"}, but this version expects ${VECTOR_GEOMETRY_VERSION}. ` +
          "Vectors are now normalised on write and similarity is derived as 1 - d^2/2; searching the old " +
          "representation returns wrong similarities rather than failing. Run `prism re-embed` or call " +
          "backfillVectorGeometry() to convert in place.",
      );
    }
  }

  /**
   * Normalise every stored vector in place and stamp the current geometry.
   * Ships with the version check rather than after it: without this, the guard
   * turns every existing database into one that refuses to search.
   */
  backfillVectorGeometry(): number {
    const rows = this.db.prepare("SELECT id, embedding FROM vec_items").all() as Array<{
      id: string;
      embedding: Buffer;
    }>;
    const update = this.db.prepare("UPDATE vec_items SET embedding = ? WHERE id = ?");
    let changed = 0;
    const run = this.db.transaction(() => {
      for (const row of rows) {
        const raw = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
        const unit = toUnitVector(raw);
        update.run(Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength), row.id);
        changed++;
      }
    });
    run();
    this.setMeta("vector_geometry_version", VECTOR_GEOMETRY_VERSION);
    return changed;
  }

  search(embedding: Float32Array, limit = 20, threshold = 0.0): Array<{ id: string; distance: number }> {
    this.assertVectorGeometry();
    const query = toUnitVector(embedding);
    const rows = this.db
      .prepare(`
      SELECT id, distance
      FROM vec_items
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `)
      .all(Buffer.from(query.buffer, query.byteOffset, query.byteLength), limit) as Array<{
      id: string;
      distance: number;
    }>;

    return rows.filter((r) => l2DistanceToCosine(r.distance) >= threshold);
  }

  getItem(id: string): StoreItem | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      type: row.type,
      number: row.number,
      repo: row.repo,
      title: row.title,
      bodySnippet: row.body_snippet,
      embedding: new Float32Array(0),
      metadata: JSON.parse(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getByNumber(repo: string, number: number): StoreItem | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE repo = ? AND number = ?").get(repo, number) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      type: row.type,
      number: row.number,
      repo: row.repo,
      title: row.title,
      bodySnippet: row.body_snippet,
      embedding: new Float32Array(0),
      metadata: JSON.parse(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAllItems(repo: string): StoreItem[] {
    const rows = this.db.prepare("SELECT * FROM items WHERE repo = ?").all(repo) as any[];
    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata_json);
      return {
        id: row.id,
        type: row.type,
        number: row.number,
        repo: row.repo,
        title: row.title,
        bodySnippet: row.body_snippet,
        embedding: new Float32Array(0),
        metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        author: metadata.author,
        authorIsBot: metadata.authorIsBot,
        state: metadata.state,
        closedAt: metadata.closedAt,
        incidentClosed: this.incidentFlag(metadata),
        labels: metadata.labels,
        additions: metadata.additions,
        deletions: metadata.deletions,
        changedFiles: metadata.changedFiles,
        ciStatus: metadata.ciStatus,
        reviewCount: metadata.reviewCount,
        hasTests: metadata.hasTests,
        nodeId: metadata.nodeId,
        headRefOid: metadata.headRefOid,
        closesIssues: metadata.closesIssues,
        body: row.body_snippet,
      };
    });
  }

  /** Metadata-only update for unchanged items: keeps drifting fields (ciStatus,
   * reviewCount, labels, closesIssues) current without re-embedding. No-op for
   * unknown ids; never touches vec_items. */
  refreshMetadata(id: string, metadata: Record<string, unknown>): void {
    this.db.prepare("UPDATE items SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), id);
  }

  getEmbedding(id: string): Float32Array | undefined {
    const row = this.db.prepare("SELECT embedding FROM vec_items WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }

  getAllEmbeddings(repo: string): Map<string, Float32Array> {
    const rows = this.db
      .prepare(
        "SELECT v.id, v.embedding FROM vec_items v INNER JOIN items i ON v.id = i.id WHERE i.repo = ? ORDER BY v.id",
      )
      .all(repo) as any[];
    const map = new Map<string, Float32Array>();
    for (const row of rows) {
      map.set(row.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    }
    return map;
  }

  hasEmbeddings(): boolean {
    return this.db.prepare("SELECT 1 FROM vec_items LIMIT 1").get() !== undefined;
  }

  getAllItemsMulti(repos: string[]): StoreItem[] {
    if (repos.length === 1) return this.getAllItems(repos[0]);
    const placeholders = repos.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM items WHERE repo IN (${placeholders})`).all(...repos) as any[];
    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata_json);
      return {
        id: row.id,
        type: row.type,
        number: row.number,
        repo: row.repo,
        title: row.title,
        bodySnippet: row.body_snippet,
        embedding: new Float32Array(0), // lightweight — use getAllEmbeddings for vectors
        metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        author: metadata.author,
        authorIsBot: metadata.authorIsBot,
        state: metadata.state,
        closedAt: metadata.closedAt,
        incidentClosed: this.incidentFlag(metadata),
        labels: metadata.labels,
        additions: metadata.additions,
        deletions: metadata.deletions,
        changedFiles: metadata.changedFiles,
        ciStatus: metadata.ciStatus,
        reviewCount: metadata.reviewCount,
        hasTests: metadata.hasTests,
        nodeId: metadata.nodeId,
        headRefOid: metadata.headRefOid,
        closesIssues: metadata.closesIssues,
        body: row.body_snippet,
      } as StoreItem;
    });
  }

  getAllEmbeddingsMulti(repos: string[]): Map<string, Float32Array> {
    if (repos.length === 1) return this.getAllEmbeddings(repos[0]);
    const placeholders = repos.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT v.id, v.embedding FROM vec_items v INNER JOIN items i ON v.id = i.id WHERE i.repo IN (${placeholders}) ORDER BY v.id`,
      )
      .all(...repos) as any[];
    const map = new Map<string, Float32Array>();
    for (const row of rows) {
      map.set(row.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    }
    return map;
  }

  getStatsMulti(repos: string[]): { totalItems: number; prs: number; issues: number; diffs: number } {
    if (repos.length === 1) return this.getStats(repos[0]);
    const placeholders = repos.map(() => "?").join(",");
    const total =
      (this.db.prepare(`SELECT COUNT(*) as c FROM items WHERE repo IN (${placeholders})`).all(...repos) as any[])[0]
        ?.c ?? 0;
    const prs =
      (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM items WHERE repo IN (${placeholders}) AND type = 'pr'`)
          .all(...repos) as any[]
      )[0]?.c ?? 0;
    const issues =
      (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM items WHERE repo IN (${placeholders}) AND type = 'issue'`)
          .all(...repos) as any[]
      )[0]?.c ?? 0;
    const diffs =
      (this.db.prepare(`SELECT COUNT(*) as c FROM diffs WHERE repo IN (${placeholders})`).all(...repos) as any[])[0]
        ?.c ?? 0;
    return { totalItems: total, prs, issues, diffs };
  }

  cacheDiff(repo: string, number: number, patchText: string): void {
    this.db
      .prepare(`
      INSERT INTO diffs (number, repo, patch_text, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(number, repo) DO UPDATE SET
        patch_text = excluded.patch_text,
        fetched_at = excluded.fetched_at
    `)
      .run(number, repo, patchText, new Date().toISOString());
  }

  getCachedDiff(repo: string, number: number): string | undefined {
    const row = this.db.prepare("SELECT patch_text FROM diffs WHERE repo = ? AND number = ?").get(repo, number) as any;
    return row?.patch_text;
  }

  saveReview(
    repo: string,
    number: number,
    type: "pr" | "issue",
    provider: string,
    model: string,
    result: { summary: string; concerns: string[]; recommendation: string; confidence: number },
  ): void {
    this.db
      .prepare(`
      INSERT INTO reviews (number, repo, type, provider, model, summary, concerns_json, recommendation, confidence, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(number, repo) DO UPDATE SET
        type = excluded.type,
        provider = excluded.provider,
        model = excluded.model,
        summary = excluded.summary,
        concerns_json = excluded.concerns_json,
        recommendation = excluded.recommendation,
        confidence = excluded.confidence,
        reviewed_at = excluded.reviewed_at
    `)
      .run(
        number,
        repo,
        type,
        provider,
        model,
        result.summary,
        JSON.stringify(result.concerns),
        result.recommendation,
        result.confidence,
        new Date().toISOString(),
      );
  }

  getReview(
    repo: string,
    number: number,
  ):
    | {
        number: number;
        repo: string;
        type: string;
        provider: string;
        model: string;
        summary: string;
        concerns: string[];
        recommendation: string;
        confidence: number;
        reviewedAt: string;
      }
    | undefined {
    const row = this.db.prepare("SELECT * FROM reviews WHERE repo = ? AND number = ?").get(repo, number) as any;
    if (!row) return undefined;
    return {
      number: row.number,
      repo: row.repo,
      type: row.type,
      provider: row.provider,
      model: row.model,
      summary: row.summary,
      concerns: JSON.parse(row.concerns_json),
      recommendation: row.recommendation,
      confidence: row.confidence,
      reviewedAt: row.reviewed_at,
    };
  }

  getStats(repo: string): { totalItems: number; prs: number; issues: number; diffs: number } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM items WHERE repo = ?").get(repo) as any).c;
    const prs = (this.db.prepare("SELECT COUNT(*) as c FROM items WHERE repo = ? AND type = 'pr'").get(repo) as any).c;
    const issues = (
      this.db.prepare("SELECT COUNT(*) as c FROM items WHERE repo = ? AND type = 'issue'").get(repo) as any
    ).c;
    const diffs = (this.db.prepare("SELECT COUNT(*) as c FROM diffs WHERE repo = ?").get(repo) as any).c;
    return { totalItems: total, prs, issues, diffs };
  }

  getCachedAuthorMergeCount(repo: string, author: string, maxAgeHours = 24): number | undefined {
    const row = this.db
      .prepare("SELECT merge_count, cached_at FROM author_cache WHERE repo = ? AND author = ?")
      .get(repo, author) as any;
    if (!row) return undefined;
    const ageMs = Date.now() - new Date(row.cached_at).getTime();
    if (ageMs > maxAgeHours * 60 * 60 * 1000) return undefined;
    return row.merge_count;
  }

  cacheAuthorMergeCount(repo: string, author: string, mergeCount: number): void {
    this.db
      .prepare(`
        INSERT INTO author_cache (author, repo, merge_count, cached_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(author, repo) DO UPDATE SET
          merge_count = excluded.merge_count,
          cached_at = excluded.cached_at
      `)
      .run(author, repo, mergeCount, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
