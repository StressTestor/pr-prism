import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerBenchmarkCommand } from "../cli/commands/benchmark.js";
import { registerCompareCommand } from "../cli/commands/compare.js";
import { registerReEmbedCommand } from "../cli/commands/re-embed.js";
import { registerResetCommand } from "../cli/commands/reset.js";
import { registerStatsCommand } from "../cli/commands/stats.js";

describe("CLI utility commands registration", () => {
  it("registers benchmark command with expected options", () => {
    const program = new Command();
    registerBenchmarkCommand(program);

    const cmd = program.commands.find((c) => c.name() === "benchmark");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Compare embedding models");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--provider");
    expect(optionNames).toContain("--base-url");
    expect(optionNames).toContain("--dimensions");
    expect(optionNames).toContain("--models");
    expect(optionNames).toContain("--thresholds");
    expect(optionNames).toContain("--out");
    expect(optionNames).toContain("--include-bot-authors");
  });

  it("registers compare command with arguments and options", () => {
    const program = new Command();
    registerCompareCommand(program);

    const cmd = program.commands.find((c) => c.name() === "compare");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Compare two PRs/issues");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--json");
  });

  it("registers reset command with -y option", () => {
    const program = new Command();
    registerResetCommand(program);

    const cmd = program.commands.find((c) => c.name() === "reset");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Delete the local database");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--yes");
  });

  it("registers re-embed command with repo option", () => {
    const program = new Command();
    registerReEmbedCommand(program);

    const cmd = program.commands.find((c) => c.name() === "re-embed");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Re-embed all stored items");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--repo");
  });

  it("registers both stats and status commands", () => {
    const program = new Command();
    registerStatsCommand(program);

    const statsCmd = program.commands.find((c) => c.name() === "stats");
    const statusCmd = program.commands.find((c) => c.name() === "status");
    expect(statsCmd).toBeDefined();
    expect(statusCmd).toBeDefined();
    expect(statsCmd?.description()).toBe(statusCmd?.description());

    const optionNames = statsCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--json");
  });
});
