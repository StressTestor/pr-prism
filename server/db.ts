import { existsSync } from "node:fs";
import { join } from "node:path";
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

/** Return and clear all queued webhook events for a repo. */
export function drainWebhookQueue(owner: string, repo: string): unknown[] {
  const key = repoKey(owner, repo);
  const queue = webhookQueues.get(key);
  if (!queue || queue.length === 0) return [];
  const events = [...queue];
  webhookQueues.delete(key);
  return events;
}
