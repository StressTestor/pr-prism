import type { Command } from "commander";
import { registerBenchmarkCommand } from "./commands/benchmark.js";
import { registerCompareCommand } from "./commands/compare.js";
import { registerDecideCommand } from "./commands/decide.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerDupesCommand } from "./commands/dupes.js";
import { registerHousekeepingCommand } from "./commands/housekeeping.js";
import { registerInitCommand } from "./commands/init.js";
import { registerMaintainerCommand } from "./commands/maintainer.js";
import { registerPipelineCommand } from "./commands/pipeline.js";
import { registerRankCommand } from "./commands/rank.js";
import { registerReEmbedCommand } from "./commands/re-embed.js";
import { registerReportCommand } from "./commands/report.js";
import { registerResetCommand } from "./commands/reset.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerScanCommand } from "./commands/scan.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerTriageCommand } from "./commands/triage.js";
import { registerVisionCommand } from "./commands/vision.js";

/**
 * Registers all PR-Prism CLI commands onto the given Commander instance.
 */
export function registerCommands(program: Command): Command {
  registerInitCommand(program);
  registerDoctorCommand(program);
  registerScanCommand(program);
  registerDupesCommand(program);
  registerRankCommand(program);
  registerVisionCommand(program);
  registerReviewCommand(program);
  registerTriageCommand(program);
  registerCompareCommand(program);
  registerBenchmarkCommand(program);
  registerResetCommand(program);
  registerReEmbedCommand(program);
  registerStatsCommand(program);
  registerReportCommand(program);
  registerMaintainerCommand(program);
  registerHousekeepingCommand(program);
  registerDecideCommand(program);
  registerPipelineCommand(program);

  return program;
}
