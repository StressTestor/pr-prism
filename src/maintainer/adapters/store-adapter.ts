/**
 * Maintainer Workbench — VectorStore Adapter
 *
 * Reads items from SQLite VectorStore and projects them into typed PRItem instances.
 */

import type { VectorStore } from "../../store.js";
import type { PRItem } from "../../types.js";

/**
 * Retrieves all items for a given repository from the VectorStore.
 *
 * @param store The active VectorStore instance
 * @param repo Full repository name (e.g. "owner/repo")
 * @returns Array of PRItem instances stored in the database
 */
export function getStoreItems(store: VectorStore, repo: string): PRItem[] {
  return store.getAllItems(repo) as unknown as PRItem[];
}

/**
 * Retrieves a single item by repository and issue/PR number.
 * Ensures metadata fields are accessible directly on the returned item.
 *
 * @param store The active VectorStore instance
 * @param repo Full repository name (e.g. "owner/repo")
 * @param number Issue or pull request number
 * @returns The PRItem if found, otherwise undefined
 */
export function getStoreItem(store: VectorStore, repo: string, number: number): PRItem | undefined {
  const item = store.getByNumber(repo, number);
  if (!item) return undefined;
  const metadata = item.metadata ?? {};
  return {
    ...metadata,
    ...item,
    body: (item as any).body ?? item.bodySnippet ?? (metadata as any).body ?? "",
    labels: (item as any).labels ?? (metadata as any).labels ?? [],
    state: (item as any).state ?? (metadata as any).state ?? "open",
    author: (item as any).author ?? (metadata as any).author ?? "unknown",
  } as unknown as PRItem;
}
