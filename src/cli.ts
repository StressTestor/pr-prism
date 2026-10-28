#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProgram } from "./cli/program.js";

const program = createProgram();

/**
 * Determines whether the current module is the entry point executed directly by Node.
 * Compares the canonicalized real paths of process.argv[1] and import.meta.url,
 * accounting for symlinks and preventing false-positive execution when imported
 * by unrelated scripts (e.g., scripts named cli.js, cli.ts, or prism).
 */
export function isDirectRun(argv1: string | undefined = process.argv[1], metaUrl: string = import.meta.url): boolean {
  if (!argv1 || !metaUrl) return false;
  try {
    const argPath = realpathSync(resolve(argv1));
    const selfPath = realpathSync(fileURLToPath(metaUrl));
    return argPath === selfPath;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  program.parseAsync().catch((err: any) => {
    // Print clean error message without stack trace for known errors
    const message = err?.message || String(err);
    console.error(`error: ${message}`);
    process.exit(1);
  });
}

export { program, createProgram };
