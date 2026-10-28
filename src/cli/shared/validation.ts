import chalk from "chalk";

/**
 * Validates that mutually exclusive flags --json and --output are not specified simultaneously.
 */
export function validateJsonOutputMutex(
  opts: { json?: boolean; output?: string },
  errorMessage = "Cannot use --json and --output together",
): void {
  if (opts.json && opts.output) {
    console.error(chalk.red(errorMessage));
    process.exit(1);
  }
}
