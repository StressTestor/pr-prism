import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileIncidentWindows, type IncidentWindow } from "../src/incident.js";

export interface ServerConfig {
  port: number;
  githubAppId: string;
  githubPrivateKeyPath: string;
  githubWebhookSecret: string;
  jinaApiKey: string;
  dataDir: string;
}

export interface RepoConfig {
  /** Repository-wide events that closed items for reasons unrelated to their
   * quality. PRs closed inside a window rank as open. See src/incident.ts. */
  incidents: IncidentWindow[];
  autoClose: boolean;
  autoCloseThreshold: number;
  similarityThreshold: number;
  weeklyDigest: boolean;
  smartRouting: boolean;
}

export const DEFAULT_REPO_CONFIG: RepoConfig = {
  incidents: [],
  autoClose: false,
  autoCloseThreshold: 0.95,
  similarityThreshold: 0.85,
  weeklyDigest: true,
  smartRouting: true,
};

/**
 * Load server configuration from environment variables.
 * Throws with a clear message if any required var is missing.
 */
export function loadServerConfig(): ServerConfig {
  const missing: string[] = [];

  const githubAppId = process.env.GITHUB_APP_ID ?? "";
  if (!githubAppId) missing.push("GITHUB_APP_ID");

  const githubPrivateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH ?? "";
  if (!githubPrivateKeyPath) missing.push("GITHUB_PRIVATE_KEY_PATH");

  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!githubWebhookSecret) missing.push("GITHUB_WEBHOOK_SECRET");

  const jinaApiKey = process.env.JINA_API_KEY ?? "";
  if (!jinaApiKey) missing.push("JINA_API_KEY");

  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    githubAppId,
    githubPrivateKeyPath,
    githubWebhookSecret,
    jinaApiKey,
    dataDir: process.env.PRISM_DATA_DIR ?? "./data/repos",
  };
}

/**
 * Load per-repo configuration from {dataDir}/{owner}-{repo}/config.json.
 * Returns DEFAULT_REPO_CONFIG if the file doesn't exist.
 */
export function loadRepoConfig(dataDir: string, owner: string, repo: string): RepoConfig {
  const configPath = join(dataDir, `${owner}-${repo}`, "config.json");

  if (!existsSync(configPath)) {
    return { ...DEFAULT_REPO_CONFIG };
  }

  let parsed: Partial<RepoConfig>;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<RepoConfig>;
  } catch {
    // corrupted or unreadable config - fall back to defaults
    return { ...DEFAULT_REPO_CONFIG };
  }

  // merge with defaults so any missing keys get sane values
  const merged = { ...DEFAULT_REPO_CONFIG, ...parsed };
  // Deliberately outside the catch above. A file we could not read at all is
  // one thing; a readable one declaring a window we cannot honour is another,
  // and silently treating it as "no incident" would rank the affected backlog
  // as rejected, which is the failure this setting exists to prevent.
  compileIncidentWindows(merged.incidents ?? []);
  return merged;
}

/**
 * Save per-repo configuration to {dataDir}/{owner}-{repo}/config.json.
 * Creates the directory if it doesn't exist.
 */
export function saveRepoConfig(dataDir: string, owner: string, repo: string, config: RepoConfig): void {
  const dir = join(dataDir, `${owner}-${repo}`);
  mkdirSync(dir, { recursive: true });

  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
