import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadEnvConfig, parseRepo } from "../config.js";

const ENV_KEYS = ["GITHUB_TOKEN", "EMBEDDING_BASE_URL", "EMBEDDING_DIMENSIONS", "LLM_BASE_URL"] as const;
const originalEnv = new Map<string, string | undefined>();
const missingEnvPath = join(tmpdir(), `prism-missing-env-${process.pid}`);

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.GITHUB_TOKEN = "test-token";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe("parseRepo", () => {
  it("parses valid owner/repo", () => {
    expect(parseRepo("octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("throws on missing repo name", () => {
    expect(() => parseRepo("octocat")).toThrow("invalid repo format");
  });

  it("throws on empty string", () => {
    expect(() => parseRepo("")).toThrow("invalid repo format");
  });

  it("handles repos with dots and hyphens", () => {
    expect(parseRepo("my-org/my.repo-name")).toEqual({ owner: "my-org", repo: "my.repo-name" });
  });

  it("strips https://github.com/ prefix", () => {
    expect(parseRepo("https://github.com/octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("strips github.com/ prefix without protocol", () => {
    expect(parseRepo("github.com/octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("strips .git suffix", () => {
    expect(parseRepo("https://github.com/octocat/hello-world.git")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses the SSH scp form from a git remote", () => {
    expect(parseRepo("git@github.com:octocat/hello-world.git")).toEqual({ owner: "octocat", repo: "hello-world" });
    expect(parseRepo("git@github.com:octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("rejects extra path segments", () => {
    expect(() => parseRepo("octocat/hello/world")).toThrow("invalid repo format");
  });
});

describe("loadConfig", () => {
  it("throws formatted error for invalid YAML", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "prism-test-"));
    const configPath = join(tmpDir, "prism.config.yaml");
    writeFileSync(configPath, "invalid: yaml: [broken");
    expect(() => loadConfig(configPath)).toThrow("failed to parse");
    rmSync(tmpDir, { recursive: true });
  });
});

describe("loadEnvConfig", () => {
  it.each([
    "http://localhost:8080/v1",
    "https://compatible.example/v1",
  ])("accepts an HTTP(S) embedding base URL: %s", (baseUrl) => {
    process.env.EMBEDDING_BASE_URL = baseUrl;
    expect(loadEnvConfig(missingEnvPath).EMBEDDING_BASE_URL).toBe(baseUrl);
  });

  it("normalizes trailing slashes for both base URLs", () => {
    process.env.EMBEDDING_BASE_URL = "https://embed.example/v1///";
    process.env.LLM_BASE_URL = "https://llm.example/api/";
    const env = loadEnvConfig(missingEnvPath);
    expect(env.EMBEDDING_BASE_URL).toBe("https://embed.example/v1");
    expect(env.LLM_BASE_URL).toBe("https://llm.example/api");
  });

  it("accepts an HTTP LLM base URL", () => {
    process.env.LLM_BASE_URL = "http://localhost:9000/v1";
    expect(loadEnvConfig(missingEnvPath).LLM_BASE_URL).toBe("http://localhost:9000/v1");
  });

  it.each(["not a url", "https://", "://missing"])("rejects malformed base URLs: %s", (baseUrl) => {
    process.env.EMBEDDING_BASE_URL = baseUrl;
    expect(() => loadEnvConfig(missingEnvPath)).toThrow(/EMBEDDING_BASE_URL.*valid HTTP\(S\) URL/s);
  });

  it.each(["ftp://example.com/v1", "file:///tmp/provider"])("rejects unsupported protocols: %s", (baseUrl) => {
    process.env.LLM_BASE_URL = baseUrl;
    expect(() => loadEnvConfig(missingEnvPath)).toThrow(/LLM_BASE_URL.*http.*https/s);
  });

  it("does not expose URL credentials, queries, or fragments in validation errors", () => {
    process.env.EMBEDDING_BASE_URL = "https://user:secret@example.com/v1?api_key=hidden#private";
    let message = "";
    try {
      loadEnvConfig(missingEnvPath);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("secret");
    expect(message).not.toContain("api_key");
    expect(message).not.toContain("private");
  });

  it("accepts positive integer embedding dimensions", () => {
    process.env.EMBEDDING_DIMENSIONS = "1024";
    expect(loadEnvConfig(missingEnvPath).EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it.each(["0", "-1", "1.5", "many"])("rejects invalid embedding dimensions: %s", (dimensions) => {
    process.env.EMBEDDING_DIMENSIONS = dimensions;
    expect(() => loadEnvConfig(missingEnvPath)).toThrow(/EMBEDDING_DIMENSIONS/);
  });
});
