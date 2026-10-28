import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerDoctorCommand } from "../cli/commands/doctor.js";
import { registerInitCommand } from "../cli/commands/init.js";
import { registerReportCommand } from "../cli/commands/report.js";
import { registerReviewCommand } from "../cli/commands/review.js";

describe("CLI core commands registration", () => {
  it("registers init command with repo, yes and no-verify options", () => {
    const program = new Command();
    registerInitCommand(program);

    const cmd = program.commands.find((c) => c.name() === "init");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Initialize pr-prism configuration");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--yes");
    expect(optionNames).toContain("--no-verify");
  });

  it("registers doctor command with json option", () => {
    const program = new Command();
    registerDoctorCommand(program);

    const cmd = program.commands.find((c) => c.name() === "doctor");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Check configuration");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--json");
  });

  it("registers review command with arguments and options", () => {
    const program = new Command();
    registerReviewCommand(program);

    const cmd = program.commands.find((c) => c.name() === "review");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Deep LLM review");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--model");
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--top");
    expect(optionNames).toContain("--show");
    expect(optionNames).toContain("--type");
    expect(optionNames).toContain("--json");
  });

  it("registers report command with markdown output and top options", () => {
    const program = new Command();
    registerReportCommand(program);

    const cmd = program.commands.find((c) => c.name() === "report");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Generate a markdown triage report");

    const optionNames = cmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain("--repo");
    expect(optionNames).toContain("--output");
    expect(optionNames).toContain("--top");
    expect(optionNames).toContain("--clusters");
    expect(optionNames).toContain("--verbose");
    expect(optionNames).toContain("--json");
  });
});
