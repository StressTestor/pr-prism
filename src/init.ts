// `prism init` logic, extracted from the CLI action so it can be unit-tested
// (importing cli.ts triggers program.parseAsync). The headline: make init emit a
// config actually wired to a real repo instead of the `repo: owner/repo`
// placeholder, then verify the setup end to end.

import { execFileSync } from "node:child_process";
import { parseRepo } from "./config.js";

/** Runs `git remote get-url origin` in cwd; injectable for tests. */
export type GitRunner = (cwd: string) => string;

const defaultGitRunner: GitRunner = (cwd) =>
  execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8" });

/** Detect owner/repo from the local git origin remote, or null if unavailable/non-GitHub. */
export function detectRepoFromGit(cwd: string, run: GitRunner = defaultGitRunner): string | null {
  let url: string;
  try {
    url = run(cwd).trim();
  } catch {
    return null; // not a git repo, or no origin remote
  }
  if (!url) return null;
  // Only auto-detect GitHub remotes; a non-GitHub host (e.g. git@gitlab.com:o/r)
  // would otherwise parse to a bogus owner like "git@gitlab.com:o".
  if (!/(^|@|\/\/)github\.com[/:]/.test(url)) return null;
  try {
    const { owner, repo } = parseRepo(url);
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

/** Replace the `repo:` line in the config YAML with the resolved repo. */
export function injectRepoIntoConfig(yamlText: string, repo: string): string {
  return yamlText.replace(/^repo:\s*.*$/m, `repo: ${repo}`);
}

function normalizeRepo(input: string): string | null {
  try {
    const { owner, repo } = parseRepo(input);
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

export interface ResolveInitRepoDeps {
  repoFlag?: string;
  detect: (cwd: string) => string | null;
  cwd: string;
  interactive: boolean;
  ask?: (question: string) => Promise<string>;
}

/**
 * Resolve the target repo for init. Precedence: explicit --repo flag > git origin
 * remote > interactive prompt > null (leave the placeholder for the user to edit).
 */
export async function resolveInitRepo(deps: ResolveInitRepoDeps): Promise<string | null> {
  if (deps.repoFlag) {
    const fromFlag = normalizeRepo(deps.repoFlag);
    // An explicit --repo is intent: fail loudly rather than silently falling back
    // to git detection and targeting a different repo than the user asked for.
    if (!fromFlag) {
      throw new Error(`invalid --repo "${deps.repoFlag}": expected owner/repo`);
    }
    return fromFlag;
  }
  const fromGit = deps.detect(deps.cwd);
  if (fromGit) return fromGit;
  if (deps.interactive && deps.ask) {
    const answer = (await deps.ask("target repo (owner/repo), blank to skip: ")).trim();
    if (answer) return normalizeRepo(answer);
  }
  return null;
}

/**
 * Wire a detected cloud embedding key into EMBEDDING_API_KEY (uncommenting the
 * placeholder). Without this a "detected" cloud provider still can't authenticate.
 * A null key (e.g. ollama) leaves the env untouched.
 */
export function applyEmbeddingKey(envText: string, key: string | null): string {
  if (!key) return envText;
  if (/^#?\s*EMBEDDING_API_KEY=.*$/m.test(envText)) {
    return envText.replace(/^#?\s*EMBEDDING_API_KEY=.*$/m, `EMBEDDING_API_KEY=${key}`);
  }
  return `${envText.replace(/\n?$/, "\n")}EMBEDDING_API_KEY=${key}\n`;
}

export interface InitCheck {
  name: "config" | "env" | "github" | "embedding";
  status: "pass" | "warn" | "fail";
  detail?: string;
}

export interface VerifyInitDeps {
  loadConfig: () => unknown;
  loadEnvConfig: () => unknown;
  network: boolean;
  fetchSample?: () => Promise<unknown>;
  checkEmbedding?: () => Promise<boolean>;
}

/** Lightweight post-init health check (mirrors doctor checks 1-4), injectable for tests. */
export async function verifyInit(deps: VerifyInitDeps): Promise<InitCheck[]> {
  const checks: InitCheck[] = [];

  checks.push(runSync("config", deps.loadConfig));
  checks.push(runSync("env", deps.loadEnvConfig));

  if (!deps.network) return checks;

  if (deps.fetchSample) {
    try {
      await deps.fetchSample();
      checks.push({ name: "github", status: "pass" });
    } catch (e) {
      checks.push({ name: "github", status: "fail", detail: (e as Error).message });
    }
  }
  if (deps.checkEmbedding) {
    try {
      const ok = await deps.checkEmbedding();
      checks.push({ name: "embedding", status: ok ? "pass" : "fail" });
    } catch (e) {
      checks.push({ name: "embedding", status: "fail", detail: (e as Error).message });
    }
  }
  return checks;
}

function runSync(name: "config" | "env", fn: () => unknown): InitCheck {
  try {
    fn();
    return { name, status: "pass" };
  } catch (e) {
    return { name, status: "fail", detail: (e as Error).message };
  }
}
