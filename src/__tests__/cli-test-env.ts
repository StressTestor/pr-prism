/**
 * CLI Test Environment Isolation Utilities
 *
 * Provides utilities to isolate CLI test subprocesses and prevent live credentials
 * (GitHub tokens, provider API keys, base URLs, write flags) from leaking into child
 * processes or cross-contaminating test suites.
 */

const ALLOWED_RUNTIME_ENV_VARS = [
  "PATH",
  "NODE",
  "NODE_PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
];

const FORBIDDEN_CREDENTIAL_PREFIXES = [
  "GITHUB_",
  "GH_",
  "OPENAI_",
  "ANTHROPIC_",
  "EMBEDDING_",
  "LLM_",
  "PRISM_",
  "JINA_",
  "COHERE_",
  "VOYAGE_",
  "OLLAMA_",
];

/**
 * Returns a sanitized, isolated copy of process.env containing only safe
 * runtime variables (PATH, temp directory, user/shell) and stripping all
 * credentials, API tokens, and provider configuration.
 */
export function getIsolatedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of ALLOWED_RUNTIME_ENV_VARS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // Double-check: guarantee no credential prefixes accidentally entered env
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_CREDENTIAL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }

  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) {
      delete env[key];
    } else {
      env[key] = val;
    }
  }

  return env;
}

/**
 * Captures a shallow clone of the current process.env.
 */
export function captureProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/**
 * Restores process.env to a previously captured baseline.
 * Any environment variables added after the baseline was captured are deleted,
 * and any modified/deleted baseline variables are restored.
 */
export function restoreProcessEnv(baseline: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in baseline)) {
      delete process.env[key];
    }
  }
  for (const [key, val] of Object.entries(baseline)) {
    if (val !== undefined) {
      process.env[key] = val;
    }
  }
}
