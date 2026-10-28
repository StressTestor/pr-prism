import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompareCommand } from "../cli/commands/compare.js";
import { registerDupesCommand } from "../cli/commands/dupes.js";
import { registerResetCommand } from "../cli/commands/reset.js";
import { registerReviewCommand } from "../cli/commands/review.js";
import { registerTriageCommand } from "../cli/commands/triage.js";
import { registerVisionCommand } from "../cli/commands/vision.js";
import { generateMarkdownReport } from "../cli/formatting/report.js";
import { createProgram } from "../cli/program.js";
import type { VectorStore } from "../store.js";
import type { Cluster, ScoredPR } from "../types.js";
import { captureProcessEnv, getIsolatedEnv, restoreProcessEnv } from "./cli-test-env.js";

const rootDir = resolve(__dirname, "../..");
const distCli = resolve(rootDir, "dist/cli.js");

const suiteBaselineEnv = captureProcessEnv();

beforeEach(() => {
  restoreProcessEnv(suiteBaselineEnv);
});

afterEach(() => {
  restoreProcessEnv(suiteBaselineEnv);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CLI Behavior - Serialization & JSON Output Contracts", () => {
  it("doctor --json outputs valid schema with pass/fail/warn checks", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-doctor-behavior-"));
    try {
      // Provide valid prism.config.yaml in isolated working directory
      writeFileSync(join(tempDir, "prism.config.yaml"), "repo: isolated-owner/isolated-repo\n");

      const stdout = execFileSync("node", [distCli, "doctor", "--json"], {
        cwd: tempDir,
        env: getIsolatedEnv(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("command", "doctor");
      expect(Array.isArray(parsed.checks)).toBe(true);
      expect(parsed.checks.length).toBeGreaterThanOrEqual(2);

      const configCheck = parsed.checks.find((c: any) => c.name === "config");
      expect(configCheck).toBeDefined();
      expect(configCheck.status).toBe("pass");
      expect(configCheck.detail).toContain("isolated-owner/isolated-repo");

      // Environment is missing in isolated dir, should be a reported fail check
      const envCheck = parsed.checks.find((c: any) => c.name === "env");
      expect(envCheck).toBeDefined();
      expect(envCheck.status).toBe("fail");

      // Database check warns when no prism.db exists
      const dbCheck = parsed.checks.find((c: any) => c.name === "database");
      expect(dbCheck).toBeDefined();
      expect(dbCheck.status).toBe("warn");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("doctor formatted text output presents colored check marks and summary", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-doctor-text-"));
    try {
      writeFileSync(join(tempDir, "prism.config.yaml"), "repo: text-owner/text-repo\n");

      const stdout = execFileSync("node", [distCli, "doctor"], {
        cwd: tempDir,
        env: getIsolatedEnv(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      expect(stdout).toContain("prism doctor");
      expect(stdout).toContain("config: prism.config.yaml valid");
      expect(stdout).toContain("check(s) failed");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("doctor subprocess remains isolated and offline even when parent environment contains live credentials", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-doctor-parent-leak-"));
    const savedParentEnv = captureProcessEnv();
    try {
      // Intentionally pollute parent process.env with fake production-like credentials
      process.env.GITHUB_TOKEN = "ghp_fake_production_secret_token_never_leak";
      process.env.OPENAI_API_KEY = "sk-fake_live_key_should_be_blocked";
      process.env.EMBEDDING_API_KEY = "sk-fake_embed_key";
      process.env.EMBEDDING_PROVIDER = "openai";
      process.env.LLM_API_KEY = "fake_llm_key";
      process.env.LLM_PROVIDER = "openai";
      process.env.PRISM_APPLY = "1";
      process.env.PRISM_WRITE = "1";

      writeFileSync(join(tempDir, "prism.config.yaml"), "repo: leak-test-owner/leak-test-repo\n");

      const stdout = execFileSync("node", [distCli, "doctor", "--json"], {
        cwd: tempDir,
        env: getIsolatedEnv(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("command", "doctor");

      // Verify that env check failed because parent's GITHUB_TOKEN was stripped
      const envCheck = parsed.checks.find((c: any) => c.name === "env");
      expect(envCheck).toBeDefined();
      expect(envCheck.status).toBe("fail");
      expect(envCheck.detail).toContain("GITHUB_TOKEN");

      // Verify github check never ran (which would have attempted a network call)
      const githubCheck = parsed.checks.find((c: any) => c.name === "github");
      expect(githubCheck).toBeUndefined();

      // Verify embedding and llm checks never ran
      const embedCheck = parsed.checks.find((c: any) => c.name === "embedding");
      expect(embedCheck).toBeUndefined();
      const llmCheck = parsed.checks.find((c: any) => c.name === "llm");
      expect(llmCheck).toBeUndefined();
    } finally {
      restoreProcessEnv(savedParentEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("CLI Behavior - Exit & Failure Handling", () => {
  it("compare command fails when missing required positional arguments", async () => {
    const program = new Command();
    registerCompareCommand(program);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Commander fails missing required positional arguments <number1> <number2>
    program.exitOverride();

    await expect(program.parseAsync(["node", "prism", "compare"])).rejects.toThrow();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("review command exits with error when invoked without target, --top or --show", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-review-behavior-"));
    const testEnv = captureProcessEnv();
    try {
      writeFileSync(join(tempDir, "prism.config.yaml"), "repo: rev-owner/rev-repo\n");
      writeFileSync(
        join(tempDir, ".env"),
        "GITHUB_TOKEN=ghp_dummy\nEMBEDDING_PROVIDER=openai\nEMBEDDING_API_KEY=dummy-key\nEMBEDDING_MODEL=text-embedding-3-small\nEMBEDDING_DIMENSIONS=1536\nLLM_PROVIDER=opencode\nLLM_MODEL=dummy\n",
      );

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit(1)");
      }) as any);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const prevCwd = process.cwd();
      try {
        process.chdir(tempDir);
        const program = new Command();
        registerReviewCommand(program);

        await expect(program.parseAsync(["node", "prism", "review"])).rejects.toThrow("process.exit(1)");
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringContaining("Provide a PR/issue number, --top N for batch, or --show N for history"),
        );
      } finally {
        process.chdir(prevCwd);
        exitSpy.mockRestore();
        errSpy.mockRestore();
      }
    } finally {
      restoreProcessEnv(testEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prevents temporary .env fixtures from leaking environment changes into process.env", () => {
    expect(process.env.GITHUB_TOKEN).toBe(suiteBaselineEnv.GITHUB_TOKEN);
    expect(process.env.EMBEDDING_API_KEY).toBe(suiteBaselineEnv.EMBEDDING_API_KEY);
    expect(process.env.EMBEDDING_PROVIDER).toBe(suiteBaselineEnv.EMBEDDING_PROVIDER);
  });

  it("triage command exits with error when unknown output format is provided", async () => {
    const program = new Command();
    registerTriageCommand(program);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(program.parseAsync(["node", "prism", "triage", "--output", "xml"])).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown output format: xml. Supported: markdown"));

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("dupes command exits with error when --json and --output are combined", async () => {
    const program = new Command();
    registerDupesCommand(program);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(program.parseAsync(["node", "prism", "dupes", "--json", "--output", "markdown"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Cannot use --json and --output together"));

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("vision command exits with error when --json and --output are combined", async () => {
    const program = new Command();
    registerVisionCommand(program);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(program.parseAsync(["node", "prism", "vision", "--json", "--output", "markdown"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Cannot use --json and --output together"));

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("CLI Behavior - Read-Only & Dry-Run Defaults", () => {
  it("dupes defaults to read-only with undefined applyLabels and dryRun options", () => {
    const program = createProgram();
    const dupesCmd = program.commands.find((c) => c.name() === "dupes");
    expect(dupesCmd).toBeDefined();

    // Verify option definitions
    const applyOpt = dupesCmd?.options.find((o) => o.long === "--apply-labels");
    const dryRunOpt = dupesCmd?.options.find((o) => o.long === "--dry-run");

    expect(applyOpt).toBeDefined();
    expect(dryRunOpt).toBeDefined();

    // Default parsed options without explicit flags have undefined applyLabels
    dupesCmd?.parseOptions([]);
    expect(dupesCmd?.opts().applyLabels).toBeUndefined();
  });

  it("vision defaults to read-only with undefined applyLabels", () => {
    const program = createProgram();
    const visionCmd = program.commands.find((c) => c.name() === "vision");
    expect(visionCmd).toBeDefined();

    const applyOpt = visionCmd?.options.find((o) => o.long === "--apply-labels");
    expect(applyOpt).toBeDefined();

    visionCmd?.parseOptions([]);
    expect(visionCmd?.opts().applyLabels).toBeUndefined();
  });

  it("triage defaults to read-only with undefined applyLabels", () => {
    const program = createProgram();
    const triageCmd = program.commands.find((c) => c.name() === "triage");
    expect(triageCmd).toBeDefined();

    const applyOpt = triageCmd?.options.find((o) => o.long === "--apply-labels");
    expect(applyOpt).toBeDefined();

    triageCmd?.parseOptions([]);
    expect(triageCmd?.opts().applyLabels).toBeUndefined();
  });
});

describe("CLI Behavior - Markdown Report Formatting Details", () => {
  it("formats non-verbose report with largest duplicate groups when clusters have >= 10 items", () => {
    const items: ScoredPR[] = [];
    for (let i = 1; i <= 12; i++) {
      items.push({
        repo: "owner/repo",
        number: i,
        title: `Mega duplicate issue #${i}`,
        body: "Repeated bug report",
        author: `user${i}`,
        state: "open",
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-02T00:00:00Z",
        labels: [],
        score: 6.0,
        signals: {
          hasTests: 0,
          ciPassing: 0,
          diffSize: 0,
          authorHistory: 0,
          descriptionQuality: 0,
          reviewApprovals: 0,
        },
        type: "issue",
      });
    }

    const cluster: Cluster = {
      id: 42,
      theme: "Repeated crash on startup",
      items,
      avgSimilarity: 0.88,
      minSimilarity: 0.75, // loose
      bestPick: items[0],
    };

    const dummyStore = {
      getEmbedding: vi.fn().mockReturnValue(null),
    } as unknown as VectorStore;

    const report = generateMarkdownReport({
      repoFull: "owner/repo",
      date: "2026-10-26",
      stats: { totalItems: 12, prs: 0, issues: 12 },
      clusters: [cluster],
      ranked: [],
      visionResults: null,
      topN: 10,
      clusterN: 10,
      verbose: false, // non-verbose mode
      store: dummyStore,
    });

    expect(report).toContain("## largest duplicate groups");
    expect(report).toContain("### cluster #42: Repeated crash on startup (12 items)");
    expect(report).toContain("loose ⚠");
    expect(report).not.toContain("## cluster details");
  });

  it("escapes table cells to protect against markdown row-injection", () => {
    const maliciousItem: ScoredPR = {
      repo: "owner/repo",
      number: 99,
      title: "Title with | pipe | characters and \n newlines",
      body: "details",
      author: "attacker | bad",
      state: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      labels: [],
      score: 5.0,
      signals: {
        hasTests: 0,
        ciPassing: 0,
        diffSize: 0,
        authorHistory: 0,
        descriptionQuality: 0,
        reviewApprovals: 0,
      },
      type: "pr",
    };

    const cluster: Cluster = {
      id: 1,
      theme: "Theme with | pipe | characters",
      items: [maliciousItem],
      avgSimilarity: 0.95,
      minSimilarity: 0.92,
      bestPick: maliciousItem,
    };

    const dummyStore = {
      getEmbedding: vi.fn().mockReturnValue(null),
    } as unknown as VectorStore;

    const report = generateMarkdownReport({
      repoFull: "owner/repo",
      date: "2026-10-26",
      stats: { totalItems: 1, prs: 1, issues: 0 },
      clusters: [cluster],
      ranked: [{ number: 99, score: 5.0, author: "attacker | bad", title: maliciousItem.title }],
      visionResults: null,
      topN: 5,
      clusterN: 5,
      verbose: true,
      store: dummyStore,
    });

    // In markdown tables, raw '|' inside cell content must be escaped or stripped
    expect(report).not.toContain("| Title with | pipe |");
    expect(report).toContain("Theme with \\| pipe \\| characters");
  });
});

describe("CLI Behavior - Working Directory & Database Path Isolation", () => {
  it("resolves database relative to custom working directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-cwd-test-"));
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const prevCwd = process.cwd();
      const savedEnv = { ...process.env };

      try {
        delete process.env.PRISM_DATA_DIR;
        delete process.env.PRISM_DB_PATH;
        process.chdir(tempDir);
        const program = new Command();
        registerResetCommand(program);

        // When invoked in tempDir, it should check ${tempDir}/data/prism.db
        await program.parseAsync(["node", "prism", "reset", "-y"]);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`No database found at ${tempDir}/data/prism.db`));
      } finally {
        process.chdir(prevCwd);
        process.env = savedEnv;
        logSpy.mockRestore();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
