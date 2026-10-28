import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram, isDirectRun, program } from "../cli.js";
import { getIsolatedEnv } from "./cli-test-env.js";

const rootDir = resolve(__dirname, "../..");
const distCli = resolve(rootDir, "dist/cli.js");
const srcCli = resolve(rootDir, "src/cli.ts");

describe("CLI Direct-Run Detection & Entry Point Identity (P2)", () => {
  it("case 1: direct node dist/cli.js executes as entry point", () => {
    expect(existsSync(distCli)).toBe(true);
    const stdout = execFileSync("node", [distCli, "--version"], {
      env: getIsolatedEnv(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(stdout.trim()).toBe("4.0.0");
  });

  it("case 2: direct source execution using tsx executes as entry point", () => {
    const tsxBin = resolve(__dirname, "../../node_modules/.bin/tsx");
    const stdout = execFileSync(tsxBin, [srcCli, "--version"], {
      env: getIsolatedEnv(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(stdout.trim()).toBe("4.0.0");
  }, 15_000);

  it("case 3: symlinked prism binary resolves target and executes as entry point", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-symlink-test-"));
    try {
      const symlinkPath = join(tempDir, "prism");
      symlinkSync(distCli, symlinkPath);

      const stdout = execFileSync("node", [symlinkPath, "--version"], {
        env: getIsolatedEnv(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(stdout.trim()).toBe("4.0.0");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("case 4: import from unrelated cli.js does NOT activate argument parser", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-unrelated-cli-"));
    try {
      const scriptPath = join(tempDir, "cli.js");
      const distUrl = pathToFileURL(distCli).href;

      writeFileSync(
        scriptPath,
        `import { isDirectRun, program } from ${JSON.stringify(distUrl)};
console.log("directRun:" + isDirectRun());
console.log("hasProgram:" + Boolean(program && program.name() === "prism"));
`,
      );

      // Pass arguments that would trigger a Commander parse failure if activated
      const stdout = execFileSync("node", [scriptPath, "some", "unknown", "arguments"], {
        env: getIsolatedEnv(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      expect(stdout).toContain("directRun:false");
      expect(stdout).toContain("hasProgram:true");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("case 5: import from unrelated prism-named executable does NOT activate argument parser", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prism-unrelated-prism-"));
    try {
      const scriptPath = join(tempDir, "prism");
      const distUrl = pathToFileURL(distCli).href;

      writeFileSync(
        scriptPath,
        `import { isDirectRun, program } from ${JSON.stringify(distUrl)};
console.log("directRun:" + isDirectRun());
console.log("hasProgram:" + Boolean(program && program.name() === "prism"));
`,
      );
      chmodSync(scriptPath, 0o755);

      const stdout = execFileSync("node", [scriptPath, "unknown-subcommand", "--invalid-flag"], {
        env: getIsolatedEnv(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      expect(stdout).toContain("directRun:false");
      expect(stdout).toContain("hasProgram:true");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("case 6: programmatic createProgram() creates clean independent instances", () => {
    const p1 = createProgram();
    const p2 = createProgram();

    expect(p1).not.toBe(p2);
    expect(p1.name()).toBe("prism");
    expect(p2.name()).toBe("prism");
    expect(p1.commands.length).toBe(p2.commands.length);
    expect(p1.commands.length).toBeGreaterThan(10);
  });

  it("case 7: no argument parsing occurs on module import in tests", () => {
    expect(program).toBeDefined();
    expect(isDirectRun()).toBe(false);
  });
});
