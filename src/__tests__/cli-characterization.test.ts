import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getIsolatedEnv } from "./cli-test-env.js";

const rootDir = resolve(__dirname, "../..");
const distCli = resolve(rootDir, "dist/cli.js");
const srcCli = resolve(rootDir, "src/cli.ts");

function runCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const isBuilt = existsSync(distCli);
  const cmd = isBuilt ? "node" : "npx";
  const cmdArgs = isBuilt ? [distCli, ...args] : ["tsx", srcCli, ...args];

  try {
    const stdout = execFileSync(cmd, cmdArgs, {
      cwd: options.cwd || rootDir,
      env: options.env || getIsolatedEnv(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || "",
      exitCode: error.status ?? 1,
    };
  }
}

describe("CLI Characterization - Help & Version", () => {
  it("reports version with -V and --version", () => {
    const v1 = runCli(["-V"]);
    expect(v1.exitCode).toBe(0);
    expect(v1.stdout.trim()).toBe("4.0.0");

    const v2 = runCli(["--version"]);
    expect(v2.exitCode).toBe(0);
    expect(v2.stdout.trim()).toBe("4.0.0");
  });

  it("displays help with -h and --help", () => {
    const res1 = runCli(["-h"]);
    expect(res1.exitCode).toBe(0);
    expect(res1.stdout).toContain("Usage: prism [options] [command]");
    expect(res1.stdout).toContain("BYOK GitHub PR/Issue triage tool");

    const res2 = runCli(["--help"]);
    expect(res2.exitCode).toBe(0);
    expect(res2.stdout).toBe(res1.stdout);
  });

  it("lists all expected commands in root help", () => {
    const res = runCli(["--help"]);
    const expectedCommands = [
      "init",
      "doctor",
      "scan",
      "dupes",
      "rank",
      "vision",
      "review",
      "triage",
      "compare",
      "benchmark",
      "reset",
      "re-embed",
      "stats",
      "status",
      "report",
    ];

    for (const cmd of expectedCommands) {
      expect(res.stdout).toMatch(new RegExp(`\\b${cmd}\\b`));
    }
  });
});

describe("CLI Characterization - Command Option Signatures", () => {
  const commandHelpExpectations: Record<string, string[]> = {
    init: ["--repo", "--yes", "--no-verify"],
    doctor: ["--json"],
    scan: ["--repo", "--since", "--state", "--rest", "--json"],
    dupes: [
      "--threshold",
      "--repo",
      "--cluster",
      "--apply-labels",
      "--dry-run",
      "--json",
      "--output",
      "--starmap",
      "--housekeeping",
    ],
    rank: ["--top", "--explain", "--json", "--repo"],
    vision: ["--doc", "--repo", "--apply-labels", "--dry-run", "--json", "--output", "--stats", "--detail"],
    review: ["--model", "--repo", "--top", "--show", "--type", "--json"],
    triage: ["--repo", "--apply-labels", "--dry-run", "--top", "--rest", "--output"],
    compare: ["--repo", "--json", "<number1> <number2>"],
    benchmark: [
      "--repo",
      "--provider",
      "--base-url",
      "--dimensions",
      "--models",
      "--thresholds",
      "--out",
      "--include-bot-authors",
    ],
    reset: ["--yes"],
    "re-embed": ["--repo"],
    stats: ["--repo", "--json"],
    status: ["--repo", "--json"],
    report: ["--repo", "--output", "--top", "--clusters", "--verbose", "--json"],
  };

  for (const [cmd, expectedFlags] of Object.entries(commandHelpExpectations)) {
    it(`renders help with all expected options for command '${cmd}'`, () => {
      const res = runCli([cmd, "--help"]);
      expect(res.exitCode).toBe(0);
      for (const flag of expectedFlags) {
        expect(res.stdout).toContain(flag);
      }
    });
  }
});

describe("CLI Characterization - Validation & Mutex Rules", () => {
  it("rejects unknown commands with exit code 1", () => {
    const res = runCli(["unknown-command"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("error: unknown command 'unknown-command'");
  });

  it("enforces mutex between --json and --output in dupes", () => {
    const res = runCli(["dupes", "--json", "--output", "markdown"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Cannot use --json and --output together");
  });

  it("enforces mutex between --json and --output in vision", () => {
    const res = runCli(["vision", "--json", "--output", "markdown"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Cannot use --json and --output together");
  });

  it("rejects unsupported output format in triage", () => {
    const res = runCli(["triage", "--output", "html"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Unknown output format: html. Supported: markdown");
  });

  it("handles reset gracefully in isolated temp dir when database does not exist", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-reset-absent-"));
    try {
      const res = runCli(["reset", "-y"], { cwd: tempDir });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(`No database found at ${join(tempDir, "data", "prism.db")}`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes disposable database fixture in isolated temp dir while preserving sentinel files", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-reset-fixture-"));
    try {
      const dataDir = join(tempDir, "data");
      mkdirSync(dataDir, { recursive: true });

      const dbPath = join(dataDir, "prism.db");
      const walPath = join(dataDir, "prism.db-wal");
      const shmPath = join(dataDir, "prism.db-shm");
      const sentinelInside = join(dataDir, "sentinel.txt");
      const sentinelOutside = join(tempDir, "important-user-file.txt");

      writeFileSync(dbPath, "SQLite format 3\0fixture");
      writeFileSync(walPath, "wal-fixture");
      writeFileSync(shmPath, "shm-fixture");
      writeFileSync(sentinelInside, "keep-me-safe");
      writeFileSync(sentinelOutside, "do-not-delete");

      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(walPath)).toBe(true);
      expect(existsSync(shmPath)).toBe(true);

      const res = runCli(["reset", "-y"], { cwd: tempDir });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Database deleted. Run `prism scan` to rebuild.");

      // DB and WAL/SHM deleted
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(walPath)).toBe(false);
      expect(existsSync(shmPath)).toBe(false);

      // Unrelated sentinel files remain completely untouched
      expect(existsSync(sentinelInside)).toBe(true);
      expect(existsSync(sentinelOutside)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
