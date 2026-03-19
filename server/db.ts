import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { VectorStore } from "../src/store.js";

export interface RepoStatus {
  itemCount: number;
  embeddingCount: number;
  lastSyncTime: string | undefined;
}

// in-memory scanning flags — lost on restart, which is fine since
// install events re-trigger the backlog scan anyway
const scanningRepos = new Map<string, boolean>();

// in-memory webhook queue — events that arrive while a repo is
// still doing its initial backlog scan get parked here
const webhookQueues = new Map<string, unknown[]>();

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/** Returns the canonical DB path for a repo: {dataDir}/{owner}-{repo}/prism.db */
export function getRepoDBPath(dataDir: string, owner: string, repo: string): string {
  return join(dataDir, `${owner}-${repo}`, "prism.db");
}

/**
 * Opens (or creates) a VectorStore for the given repo.
 * The parent directory is created by VectorStore's constructor (mkdirSync recursive).
 */
export function openRepoDB(
  dataDir: string,
  owner: string,
  repo: string,
  dimensions?: number,
  model?: string,
): VectorStore {
  const dbPath = getRepoDBPath(dataDir, owner, repo);
  return new VectorStore(dbPath, dimensions, model);
}

/** Returns item count, embedding count, and last sync time for a repo DB. */
export function getRepoStatus(dataDir: string, owner: string, repo: string): RepoStatus {
  const dbPath = getRepoDBPath(dataDir, owner, repo);

  if (!existsSync(dbPath)) {
    return { itemCount: 0, embeddingCount: 0, lastSyncTime: undefined };
  }

  const store = new VectorStore(dbPath);
  try {
    const stats = store.getStats(`${owner}/${repo}`);
    const lastSync = store.getMeta("last_sync");
    return {
      itemCount: stats.totalItems,
      embeddingCount: stats.prs + stats.issues, // items with embeddings
      lastSyncTime: lastSync,
    };
  } finally {
    store.close();
  }
}

/** Check whether a repo is currently doing its initial backlog scan. */
export function isRepoScanning(owner: string, repo: string): boolean {
  return scanningRepos.get(repoKey(owner, repo)) === true;
}

/** Mark a repo as scanning (true) or done (false). */
export function setRepoScanning(owner: string, repo: string, scanning: boolean): void {
  const key = repoKey(owner, repo);
  if (scanning) {
    scanningRepos.set(key, true);
  } else {
    scanningRepos.delete(key);
  }
}

/** Push a webhook event onto the in-memory queue for a repo. */
export function queueWebhook(owner: string, repo: string, event: unknown): void {
  const key = repoKey(owner, repo);
  let queue = webhookQueues.get(key);
  if (!queue) {
    queue = [];
    webhookQueues.set(key, queue);
  }
  queue.push(event);
}

/** Count items created on or after the given ISO date string. */
export function getItemCountSince(dataDir: string, owner: string, repo: string, since: string): number {
  const dbPath = getRepoDBPath(dataDir, owner, repo);
  if (!existsSync(dbPath)) return 0;

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) as c FROM items WHERE repo = ? AND created_at >= ?")
      .get(`${owner}/${repo}`, since) as { c: number } | undefined;
    return row?.c ?? 0;
  } finally {
    db.close();
  }
}

/** Return and clear all queued webhook events for a repo. */
export function drainWebhookQueue(owner: string, repo: string): unknown[] {
  const key = repoKey(owner, repo);
  const queue = webhookQueues.get(key);
  if (!queue || queue.length === 0) return [];
  const events = [...queue];
  webhookQueues.delete(key);
  return events;
}

/**
 * Scan the dataDir for repo directories (format: {owner}-{repo}/prism.db).
 * Returns array of { owner, repo } for each installed repo.
 */
export function listInstalledRepos(dataDir: string): Array<{ owner: string; repo: string }> {
  if (!existsSync(dataDir)) return [];

  const entries = readdirSync(dataDir, { withFileTypes: true });
  const repos: Array<{ owner: string; repo: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // directory format: {owner}-{repo}
    const dashIdx = entry.name.indexOf("-");
    if (dashIdx < 1) continue;

    const dbPath = join(dataDir, entry.name, "prism.db");
    if (!existsSync(dbPath)) continue;

    const owner = entry.name.slice(0, dashIdx);
    const repo = entry.name.slice(dashIdx + 1);
    if (owner && repo) {
      repos.push({ owner, repo });
    }
  }

  return repos;
}
