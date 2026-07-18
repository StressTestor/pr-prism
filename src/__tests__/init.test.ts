import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyEmbeddingKey,
  detectRepoFromGit,
  injectRepoIntoConfig,
  resolveInitRepo,
  verifyInit,
  verifyInitEmbedding,
} from "../init.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("detectRepoFromGit", () => {
  it("parses owner/repo from an https origin", () => {
    const run = () => "https://github.com/octo/widgets.git\n";
    expect(detectRepoFromGit("/repo", run)).toBe("octo/widgets");
  });

  it("parses owner/repo from an SSH origin", () => {
    const run = () => "git@github.com:octo/widgets.git\n";
    expect(detectRepoFromGit("/repo", run)).toBe("octo/widgets");
  });

  it("returns null when git errors (not a repo / no origin)", () => {
    const run = () => {
      throw new Error("fatal: not a git repository");
    };
    expect(detectRepoFromGit("/nope", run)).toBeNull();
  });

  it("returns null when the remote is not a github url", () => {
    const run = () => "https://gitlab.com/octo/widgets.git\n";
    expect(detectRepoFromGit("/repo", run)).toBeNull();
  });

  it("returns null for a non-github SSH remote (no bogus owner)", () => {
    const run = () => "git@gitlab.com:octo/widgets.git\n";
    expect(detectRepoFromGit("/repo", run)).toBeNull();
  });
});

describe("injectRepoIntoConfig", () => {
  it("replaces the repo placeholder with the real repo, leaving the rest intact", () => {
    const yaml = "version: 1\nrepo: owner/repo\nthreshold: 0.85\n";
    const out = injectRepoIntoConfig(yaml, "octo/widgets");
    expect(out).toContain("repo: octo/widgets");
    expect(out).not.toContain("owner/repo");
    expect(out).toContain("threshold: 0.85");
  });
});

describe("resolveInitRepo", () => {
  const detectNone = () => null;
  it("prefers the --repo flag over the git remote", async () => {
    const r = await resolveInitRepo({
      repoFlag: "flag/wins",
      detect: () => "git/remote",
      cwd: "/x",
      interactive: false,
    });
    expect(r).toBe("flag/wins");
  });

  it("falls back to the git remote when no flag", async () => {
    const r = await resolveInitRepo({
      detect: () => "git/remote",
      cwd: "/x",
      interactive: false,
    });
    expect(r).toBe("git/remote");
  });

  it("normalizes a messy --repo flag through parseRepo", async () => {
    const r = await resolveInitRepo({
      repoFlag: "https://github.com/octo/widgets.git",
      detect: detectNone,
      cwd: "/x",
      interactive: false,
    });
    expect(r).toBe("octo/widgets");
  });

  it("returns null in non-interactive mode with no flag and no remote (leaves placeholder)", async () => {
    const r = await resolveInitRepo({ detect: detectNone, cwd: "/x", interactive: false });
    expect(r).toBeNull();
  });

  it("prompts only when interactive and unresolved", async () => {
    const r = await resolveInitRepo({
      detect: detectNone,
      cwd: "/x",
      interactive: true,
      ask: async () => "typed/repo",
    });
    expect(r).toBe("typed/repo");
  });

  it("rejects an invalid --repo flag loudly instead of silently falling back", async () => {
    await expect(
      resolveInitRepo({
        repoFlag: "not-a-repo",
        detect: () => "git/remote",
        cwd: "/x",
        interactive: false,
      }),
    ).rejects.toThrow(/--repo/);
  });
});

describe("applyEmbeddingKey", () => {
  it("writes EMBEDDING_API_KEY when a cloud provider key is detected", () => {
    const env = "EMBEDDING_PROVIDER=ollama\n# EMBEDDING_API_KEY=  # not needed for ollama\n";
    const out = applyEmbeddingKey(env, "jina_abc123");
    expect(out).toMatch(/^EMBEDDING_API_KEY=jina_abc123$/m);
    expect(out).not.toMatch(/^#\s*EMBEDDING_API_KEY=/m);
  });

  it("leaves env untouched when there is no key (ollama)", () => {
    const env = "EMBEDDING_PROVIDER=ollama\n# EMBEDDING_API_KEY=  # not needed for ollama\n";
    expect(applyEmbeddingKey(env, null)).toBe(env);
  });
});

describe("verifyInit", () => {
  const okDeps = {
    loadConfig: () => ({}),
    loadEnvConfig: () => ({}),
    network: true,
    fetchSample: async () => [{ number: 1 }],
    checkEmbedding: async () => true,
  };

  it("passes every check when config, env, github, and embedding are healthy", async () => {
    const checks = await verifyInit(okDeps);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
    expect(checks.map((c) => c.name)).toContain("github");
  });

  it("fails the github check when the repo is unreachable", async () => {
    const checks = await verifyInit({
      ...okDeps,
      fetchSample: async () => {
        throw new Error("404 Not Found");
      },
    });
    expect(checks.find((c) => c.name === "github")?.status).toBe("fail");
  });

  it("fails the config check when config is invalid", async () => {
    const checks = await verifyInit({
      ...okDeps,
      loadConfig: () => {
        throw new Error("invalid config");
      },
    });
    expect(checks.find((c) => c.name === "config")?.status).toBe("fail");
  });

  it("skips network checks when network is false", async () => {
    const checks = await verifyInit({ ...okDeps, network: false });
    expect(checks.find((c) => c.name === "github")).toBeUndefined();
    expect(checks.find((c) => c.name === "embedding")).toBeUndefined();
  });

  it("performs a real embedding request before reporting init verification success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [{ index: 0, embedding: [1, 2] }] }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const checks = await verifyInit({
      ...okDeps,
      checkEmbedding: () =>
        verifyInitEmbedding({
          provider: "openai",
          apiKey: "init-key",
          model: "custom",
          baseUrl: "https://compatible.example/v1",
          dimensions: 2,
        }),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(checks.find((check) => check.name === "embedding")?.status).toBe("pass");
  });

  it("reports init embedding verification failure for an unreachable or unauthorized provider", async () => {
    const secret = "init-secret-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(`unauthorized ${secret}`),
      }),
    );

    const checks = await verifyInit({
      ...okDeps,
      checkEmbedding: () => verifyInitEmbedding({ provider: "openai", apiKey: secret, model: "custom", dimensions: 2 }),
    });
    const embedding = checks.find((check) => check.name === "embedding");

    expect(embedding?.status).toBe("fail");
    expect(embedding?.detail).toContain("Check EMBEDDING_API_KEY in your .env");
    expect(embedding?.detail).not.toContain(secret);
  });

  it("does not probe Ollama twice during init verification", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ embeddings: [[1, 2, 3]] }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyInitEmbedding({ provider: "ollama", model: "nomic-embed-text" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
