import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { resolve } from "path";
import { mkdirSync } from "fs";
import type { StoreItem } from "./types.js";

export class VectorStore {
  private db: Database.Database;
  private dimensions: number;

  constructor(dbPath?: string, dimensions = 1536) {
    const p = dbPath || resolve(process.cwd(), "data", "prism.db");
    mkdirSync(resolve(p, ".."), { recursive: true });
    this.db = new Database(p);
    this.dimensions = dimensions;
    this.init();
  }

  private init() {
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");

    // Validate dimensions if vec_items already exists
    const tableCheck = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_items'"
    ).get() as any;

    if (tableCheck) {
      const row = this.db.prepare("SELECT embedding FROM vec_items LIMIT 1").get() as any;
      if (row) {
        const existingDim = new Float32Array(row.embedding.buffer).length;
        if (existingDim !== this.dimensions) {
          this.db.close();
          throw new Error(
            `Dimension mismatch: database has ${existingDim}-dim embeddings but provider uses ${this.dimensions}. ` +
            `Run \`prism reset\` to clear the database and re-scan.`
          );
        }
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

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}]
      );

      CREATE INDEX IF NOT EXISTS idx_items_repo ON items(repo);
      CREATE INDEX IF NOT EXISTS idx_items_number ON items(number, repo);
    `);
  }

  upsert(item: StoreItem): void {
    const id = `${item.repo}:${item.type}:${item.number}`;

    this.db.prepare(`
      INSERT INTO items (id, type, number, repo, title, body_snippet, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        body_snippet = excluded.body_snippet,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(id, item.type, item.number, item.repo, item.title, item.bodySnippet,
      JSON.stringify(item.metadata), item.createdAt, item.updatedAt);

    this.db.prepare("DELETE FROM vec_items WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO vec_items (id, embedding) VALUES (?, ?)").run(
      id,
      Buffer.from(item.embedding.buffer)
    );
  }

  search(embedding: Float32Array, limit = 20, threshold = 0.0): Array<{ id: string; distance: number }> {
    const rows = this.db.prepare(`
      SELECT id, distance
      FROM vec_items
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(Buffer.from(embedding.buffer), limit) as Array<{ id: string; distance: number }>;

    // sqlite-vec returns cosine distance when using vec0 with float arrays
    // cosine similarity = 1 - cosine distance
    return rows.filter(r => (1 - r.distance) >= threshold);
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
    return rows.map(row => {
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
        state: metadata.state,
        labels: metadata.labels,
        additions: metadata.additions,
        deletions: metadata.deletions,
        changedFiles: metadata.changedFiles,
        ciStatus: metadata.ciStatus,
        reviewCount: metadata.reviewCount,
        hasTests: metadata.hasTests,
        body: row.body_snippet,
      };
    });
  }

  getEmbedding(id: string): Float32Array | undefined {
    const row = this.db.prepare("SELECT embedding FROM vec_items WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return new Float32Array(row.embedding.buffer);
  }

  getAllEmbeddings(repo: string): Map<string, Float32Array> {
    const items = this.db.prepare("SELECT id FROM items WHERE repo = ?").all(repo) as any[];
    const map = new Map<string, Float32Array>();
    for (const item of items) {
      const emb = this.getEmbedding(item.id);
      if (emb) map.set(item.id, emb);
    }
    return map;
  }

  cacheDiff(repo: string, number: number, patchText: string): void {
    this.db.prepare(`
      INSERT INTO diffs (number, repo, patch_text, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(number, repo) DO UPDATE SET
        patch_text = excluded.patch_text,
        fetched_at = excluded.fetched_at
    `).run(number, repo, patchText, new Date().toISOString());
  }

  getCachedDiff(repo: string, number: number): string | undefined {
    const row = this.db.prepare("SELECT patch_text FROM diffs WHERE repo = ? AND number = ?").get(repo, number) as any;
    return row?.patch_text;
  }

  getStats(repo: string): { totalItems: number; prs: number; issues: number; diffs: number } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM items WHERE repo = ?").get(repo) as any).c;
    const prs = (this.db.prepare("SELECT COUNT(*) as c FROM items WHERE repo = ? AND type = 'pr'").get(repo) as any).c;
    const issues = (this.db.prepare("SELECT COUNT(*) as c FROM items WHERE repo = ? AND type = 'issue'").get(repo) as any).c;
    const diffs = (this.db.prepare("SELECT COUNT(*) as c FROM diffs WHERE repo = ?").get(repo) as any).c;
    return { totalItems: total, prs, issues, diffs };
  }

  close(): void {
    this.db.close();
  }
}
