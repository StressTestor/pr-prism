import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { getDatabasePath, getDataDir, getPackageRoot } from "../cli/shared/paths.js";
import { askConfirmation, askQuestion } from "../cli/shared/prompts.js";
import { validateJsonOutputMutex } from "../cli/shared/validation.js";

describe("cli/shared/paths", () => {
  it("resolves package root containing package.json", () => {
    const root = getPackageRoot();
    expect(root).toBeDefined();
    expect(typeof root).toBe("string");
  });

  it("resolves data directory and database path", () => {
    const dataDir = getDataDir();
    const dbPath = getDatabasePath();
    expect(dbPath).toBe(`${dataDir}/prism.db`);
  });
});

describe("cli/shared/prompts", () => {
  it("asks a question and returns the answer", async () => {
    const input = new Readable({
      read() {
        this.push("my-org/my-repo\n");
        this.push(null);
      },
    });
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const answer = await askQuestion("Enter repo: ", input, output);
    expect(answer).toBe("my-org/my-repo");
  });

  it("handles confirmation with 'y' and 'n'", async () => {
    const inputY = new Readable({
      read() {
        this.push("y\n");
        this.push(null);
      },
    });
    const inputN = new Readable({
      read() {
        this.push("n\n");
        this.push(null);
      },
    });
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const yesResult = await askConfirmation("Proceed? ", inputY, output);
    expect(yesResult).toBe(true);

    const noResult = await askConfirmation("Proceed? ", inputN, output);
    expect(noResult).toBe(false);
  });
});

describe("cli/shared/validation", () => {
  it("does not exit when only json is specified", () => {
    expect(() => validateJsonOutputMutex({ json: true })).not.toThrow();
  });

  it("does not exit when only output is specified", () => {
    expect(() => validateJsonOutputMutex({ output: "markdown" })).not.toThrow();
  });

  it("exits with 1 when both json and output are specified", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => validateJsonOutputMutex({ json: true, output: "markdown" })).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
