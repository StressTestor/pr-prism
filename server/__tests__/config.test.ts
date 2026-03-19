import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPO_CONFIG,
  loadRepoConfig,
  loadServerConfig,
  saveRepoConfig,
} from "../config.js";
import type { RepoConfig } from "../config.js";

describe("loadServerConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // set all required vars
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_PRIVATE_KEY_PATH = "./test.pem";
    process.env.GITHUB_WEBHOOK_SECRET = "secret123";
    process.env.JINA_API_KEY = "jina_test";
  });

  afterEach(() => {
    // restore original env
    process.env = { ...originalEnv };
  });

  it("loads all required vars", () => {
    const config = loadServerConfig();
    expect(config.githubAppId).toBe("12345");
    expect(config.githubPrivateKeyPath).toBe("./test.pem");
    expect(config.githubWebhookSecret).toBe("secret123");
    expect(config.jinaApiKey).toBe("jina_test");
  });

  it("uses default port 3000", () => {
    delete process.env.PORT;
    const config = loadServerConfig();
    expect(config.port).toBe(3000);
  });

  it("respects PORT env var", () => {
    process.env.PORT = "8080";
    const config = loadServerConfig();
    expect(config.port).toBe(8080);
  });

  it("uses default dataDir", () => {
    delete process.env.PRISM_DATA_DIR;
    const config = loadServerConfig();
    expect(config.dataDir).toBe("./data/repos");
  });

  it("respects PRISM_DATA_DIR env var", () => {
    process.env.PRISM_DATA_DIR = "/srv/prism/data";
    const config = loadServerConfig();
    expect(config.dataDir).toBe("/srv/prism/data");
  });

  it("throws when GITHUB_APP_ID is missing", () => {
    delete process.env.GITHUB_APP_ID;
    expect(() => loadServerConfig()).toThrow("GITHUB_APP_ID");
  });

  it("throws when GITHUB_WEBHOOK_SECRET is missing", () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    expect(() => loadServerConfig()).toThrow("GITHUB_WEBHOOK_SECRET");
  });

  it("throws when JINA_API_KEY is missing", () => {
    delete process.env.JINA_API_KEY;
    expect(() => loadServerConfig()).toThrow("JINA_API_KEY");
  });

  it("lists all missing vars in one error", () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_PRIVATE_KEY_PATH;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.JINA_API_KEY;

    expect(() => loadServerConfig()).toThrow(
      "missing required environment variables: GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET, JINA_API_KEY",
    );
  });
});

describe("loadRepoConfig", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "prism-config-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it("returns defaults when config.json does not exist", () => {
    const config = loadRepoConfig(dataDir, "octocat", "my-repo");
    expect(config).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("reads config from disk", () => {
    const custom: RepoConfig = {
      autoClose: true,
      autoCloseThreshold: 0.9,
      similarityThreshold: 0.75,
      weeklyDigest: false,
      smartRouting: false,
    };

    saveRepoConfig(dataDir, "octocat", "my-repo", custom);
    const loaded = loadRepoConfig(dataDir, "octocat", "my-repo");

    expect(loaded).toEqual(custom);
  });

  it("merges partial config with defaults", () => {
    // write a config with only some fields
    const dir = join(dataDir, "octocat-my-repo");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ autoClose: true }),
      "utf-8",
    );

    const loaded = loadRepoConfig(dataDir, "octocat", "my-repo");

    expect(loaded.autoClose).toBe(true);
    // rest should be defaults
    expect(loaded.autoCloseThreshold).toBe(0.95);
    expect(loaded.similarityThreshold).toBe(0.85);
    expect(loaded.weeklyDigest).toBe(true);
    expect(loaded.smartRouting).toBe(true);
  });

  it("returns defaults for corrupted config file", () => {
    const dir = join(dataDir, "octocat-my-repo");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "not valid json{{{", "utf-8");

    const loaded = loadRepoConfig(dataDir, "octocat", "my-repo");
    expect(loaded).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("returns a copy, not the same DEFAULT_REPO_CONFIG reference", () => {
    const a = loadRepoConfig(dataDir, "ghost", "missing");
    const b = loadRepoConfig(dataDir, "ghost", "missing");

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a).not.toBe(DEFAULT_REPO_CONFIG);
  });
});

describe("saveRepoConfig", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "prism-config-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it("creates directory and writes config.json", () => {
    saveRepoConfig(dataDir, "octocat", "my-repo", DEFAULT_REPO_CONFIG);

    const configPath = join(dataDir, "octocat-my-repo", "config.json");
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("overwrites existing config", () => {
    saveRepoConfig(dataDir, "octocat", "my-repo", DEFAULT_REPO_CONFIG);

    const updated: RepoConfig = {
      ...DEFAULT_REPO_CONFIG,
      autoClose: true,
      autoCloseThreshold: 0.88,
    };
    saveRepoConfig(dataDir, "octocat", "my-repo", updated);

    const loaded = loadRepoConfig(dataDir, "octocat", "my-repo");
    expect(loaded.autoClose).toBe(true);
    expect(loaded.autoCloseThreshold).toBe(0.88);
  });

  it("roundtrips correctly", () => {
    const custom: RepoConfig = {
      autoClose: true,
      autoCloseThreshold: 0.92,
      similarityThreshold: 0.7,
      weeklyDigest: false,
      smartRouting: true,
    };

    saveRepoConfig(dataDir, "org", "project", custom);
    const loaded = loadRepoConfig(dataDir, "org", "project");

    expect(loaded).toEqual(custom);
  });
});

describe("DEFAULT_REPO_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_REPO_CONFIG.autoClose).toBe(false);
    expect(DEFAULT_REPO_CONFIG.autoCloseThreshold).toBe(0.95);
    expect(DEFAULT_REPO_CONFIG.similarityThreshold).toBe(0.85);
    expect(DEFAULT_REPO_CONFIG.weeklyDigest).toBe(true);
    expect(DEFAULT_REPO_CONFIG.smartRouting).toBe(true);
  });
});
