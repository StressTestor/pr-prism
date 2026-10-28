import { existsSync, unlinkSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { getDatabasePath } from "../shared/paths.js";
import { askQuestion } from "../shared/prompts.js";

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Delete the local database and start fresh")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (opts) => {
      const dbPath = getDatabasePath();
      if (!existsSync(dbPath)) {
        console.log(chalk.yellow(`No database found at ${dbPath}`));
        return;
      }

      if (!opts.yes) {
        const answer = await askQuestion(chalk.yellow("Delete database and all cached data? (y/N) "));
        if (answer.toLowerCase() !== "y") {
          console.log("Cancelled.");
          return;
        }
      }

      unlinkSync(dbPath);
      // Also remove WAL/SHM files if they exist
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
      }
      console.log(`${chalk.green("✓")} Database deleted. Run \`prism scan\` to rebuild.`);
    });
}
