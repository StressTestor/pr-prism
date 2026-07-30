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

/** Mirrors the CLI's `cluster:` block, in this file's camelCase. */
export interface RepoClusterConfig {
  /** Cluster bot-authored items too. Off by default; see src/bots.ts. */
  includeBotAuthors: boolean;
  /** Extra bot logins for this repo, added to the built-in list. */
  botAuthors: string[];
}

export interface RepoConfig {
  /** Repository-wide events that closed items for reasons unrelated to their
   * quality. PRs closed inside a window rank as open. See src/incident.ts. */
  incidents: IncidentWindow[];
  cluster: RepoClusterConfig;
  autoClose: boolean;
  autoCloseThreshold: number;
  similarityThreshold: number;
  weeklyDigest: boolean;
  smartRouting: boolean;
}

export const DEFAULT_REPO_CONFIG: RepoConfig = {
  incidents: [],
  cluster: { includeBotAuthors: false, botAuthors: [] },
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

  // merge with defaults so any missing keys get sane values. `cluster` is
  // merged a level deeper: a config setting only `botAuthors` should keep the
  // default `includeBotAuthors`, not lose it to a wholesale block replacement.
  const merged = {
    ...DEFAULT_REPO_CONFIG,
    ...parsed,
    cluster: { ...DEFAULT_REPO_CONFIG.cluster, ...(parsed.cluster ?? {}) },
  };

  // Everything below is deliberately outside the catch above. A file we could
  // not read at all is one thing; a readable one declaring settings we cannot
  // honour is another. Silently defaulting those would rank an incident backlog
  // as rejected, or ignore a repo's bot logins, which are the exact failures
  // these settings exist to prevent.
  //
  // The cast to Partial<RepoConfig> above is a claim about a hand-editable file,
  // not a fact, so the shapes that reach other modules are checked here rather
  // than failing later as `new Set(42)` somewhere in the scheduler.
  if (parsed.cluster !== undefined && (typeof parsed.cluster !== "object" || parsed.cluster === null || Array.isArray(parsed.cluster))) {
    throw new Error(`${configPath}: cluster must be an object`);
  }
  if (!Array.isArray(merged.incidents)) {
    throw new Error(`${configPath}: incidents must be a list of {start, end, reason} objects`);
  }
  if (typeof merged.cluster.includeBotAuthors !== "boolean") {
    throw new Error(`${configPath}: cluster.includeBotAuthors must be true or false`);
  }
  if (
    !Array.isArray(merged.cluster.botAuthors) ||
    merged.cluster.botAuthors.some((login) => typeof login !== "string" || login.trim() === "")
  ) {
    throw new Error(`${configPath}: cluster.botAuthors must be a list of non-empty login strings`);
  }
  // Compiled here for its validation, and the result discarded on purpose: the
  // store compiles its own copy from the same raw windows. Bounds are cheap to
  // parse and the alternative is threading a second type through openRepoDB.
  compileIncidentWindows(merged.incidents);
  return merged;
}

/**
 * loadRepoConfig, contained to one repository.
 *
 * loadRepoConfig throws on a config it cannot honour, which is right: silently
 * defaulting would rank an incident backlog as rejected or ignore a repo's bot
 * logins. But the App iterates every repo in an installation, and one repo's
 * hand-edited file must not abort that loop and silently skip the repos after
 * it - a failure that repeats identically on every webhook redelivery.
 *
 * Returns null rather than defaults. A caller that skips the repo loudly is
 * recoverable; one that proceeds on defaults has the misconfiguration hidden
 * from it, which is what throwing was meant to prevent.
 */
export function loadRepoConfigIsolated(dataDir: string, owner: string, repo: string): RepoConfig | null {
  try {
    return loadRepoConfig(dataDir, owner, repo);
  } catch (err) {
    console.error(
      `[config] ${owner}/${repo}: unusable config.json, this repo is skipped:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
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
