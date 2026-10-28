import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Command } from "commander";
import { registerCommands } from "./register-commands.js";
import { getPackageRoot } from "./shared/paths.js";

/**
 * Creates and configures the top-level Commander program for PR-Prism CLI.
 */
export function createProgram(): Command {
  const _require = createRequire(import.meta.url);
  const pkg = _require(resolve(getPackageRoot(), "package.json"));

  const program = new Command();

  program
    .name("prism")
    .description("BYOK GitHub PR/Issue triage tool — de-duplicate, rank, and vision-check PRs at scale")
    .version(pkg.version);

  registerCommands(program);

  return program;
}
