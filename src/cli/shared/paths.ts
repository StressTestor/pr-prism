import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Returns the repository/package root directory by resolving three levels
 * up from this file's directory (src/cli/shared or dist/cli/shared).
 */
export function getPackageRoot(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "../../..");
}

/**
 * Returns the data directory in the current working directory or from PRISM_DATA_DIR.
 */
export function getDataDir(): string {
  if (process.env.PRISM_DATA_DIR) {
    return resolve(process.env.PRISM_DATA_DIR);
  }
  return resolve(process.cwd(), "data");
}

/**
 * Returns the primary SQLite database path in data/prism.db, or custom/environment path.
 */
export function getDatabasePath(customPath?: string): string {
  if (customPath) {
    return resolve(customPath);
  }
  if (process.env.PRISM_DB_PATH) {
    return resolve(process.env.PRISM_DB_PATH);
  }
  return resolve(getDataDir(), "prism.db");
}

/**
 * Returns the Jev decisions SQLite database path.
 * Checks custom path, PRISM_DECISIONS_DB_PATH, decisions.db, or prism-jev-decisions.sqlite.
 */
export function getDecisionsDatabasePath(customPath?: string): string {
  if (customPath) {
    return resolve(customPath);
  }
  if (process.env.PRISM_DECISIONS_DB_PATH) {
    return resolve(process.env.PRISM_DECISIONS_DB_PATH);
  }
  const defaultPath = resolve(getDataDir(), "decisions.db");
  if (existsSync(defaultPath)) {
    return defaultPath;
  }
  const sqliteCandidate = resolve(getDataDir(), "prism-jev-decisions.sqlite");
  if (existsSync(sqliteCandidate)) {
    return sqliteCandidate;
  }
  return defaultPath;
}

/**
 * Returns the review queue SQLite database path.
 * Checks custom path, PRISM_QUEUE_DB_PATH, review-queue.sqlite, or prism-glm-review-queue.sqlite.
 */
export function getQueueDatabasePath(customPath?: string): string {
  if (customPath) {
    return resolve(customPath);
  }
  if (process.env.PRISM_QUEUE_DB_PATH) {
    return resolve(process.env.PRISM_QUEUE_DB_PATH);
  }
  const defaultPath = resolve(getDataDir(), "review-queue.sqlite");
  if (existsSync(defaultPath)) {
    return defaultPath;
  }
  const legacyCandidate = resolve(getDataDir(), "prism-glm-review-queue.sqlite");
  if (existsSync(legacyCandidate)) {
    return legacyCandidate;
  }
  return defaultPath;
}
