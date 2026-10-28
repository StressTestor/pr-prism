import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerDupesCommand } from "../cli/commands/dupes.js";
import { registerRankCommand } from "../cli/commands/rank.js";
import { registerScanCommand } from "../cli/commands/scan.js";
import { registerTriageCommand } from "../cli/commands/triage.js";
import { registerVisionCommand } from "../cli/commands/vision.js";

describe("CLI pipeline commands registration", () => {
  it("registers scan command with expected options and defaults", () => {
    const program = new Command();
    registerScanCommand(program);

    const cmd = program.commands.find((c) => c.name() === "scan");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Ingest PRs and issues");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--since");
    expect(optionNames).toContain("--state");
    expect(optionNames).toContain("--rest");
    expect(optionNames).toContain("--json");
  });

  it("registers dupes command with clustering and starmap options", () => {
    const program = new Command();
    registerDupesCommand(program);

    const cmd = program.commands.find((c) => c.name() === "dupes");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Find duplicate PR/issue clusters");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--threshold");
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--cluster");
    expect(optionNames).toContain("--apply-labels");
    expect(optionNames).toContain("--dry-run");
    expect(optionNames).toContain("--json");
    expect(optionNames).toContain("--output");
    expect(optionNames).toContain("--starmap");
    expect(optionNames).toContain("--housekeeping");
  });

  it("registers rank command with explain and top options", () => {
    const program = new Command();
    registerRankCommand(program);

    const cmd = program.commands.find((c) => c.name() === "rank");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Score and rank PRs");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--top");
    expect(optionNames).toContain("--explain");
    expect(optionNames).toContain("--json");
    expect(optionNames).toContain("--repo");
  });

  it("registers vision command with alignment options", () => {
    const program = new Command();
    registerVisionCommand(program);

    const cmd = program.commands.find((c) => c.name() === "vision");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Check PRs against vision document");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--doc");
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--apply-labels");
    expect(optionNames).toContain("--dry-run");
    expect(optionNames).toContain("--json");
    expect(optionNames).toContain("--output");
    expect(optionNames).toContain("--stats");
    expect(optionNames).toContain("--detail");
  });

  it("registers triage command with full pipeline options", () => {
    const program = new Command();
    registerTriageCommand(program);

    const cmd = program.commands.find((c) => c.name() === "triage");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Full pipeline");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--apply-labels");
    expect(optionNames).toContain("--dry-run");
    expect(optionNames).toContain("--top");
    expect(optionNames).toContain("--rest");
    expect(optionNames).toContain("--output");
  });

  it("triage rejects invalid output format", async () => {
    const program = new Command();
    registerTriageCommand(program);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(program.parseAsync(["node", "test", "triage", "--output", "pdf"])).rejects.toThrow("process.exit(1)");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown output format: pdf"));

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
