import chalk from "chalk";
import { sanitizeTitle } from "../../sanitize.js";

export interface ReviewFormattingMetadata {
  author?: string;
  additions?: number;
  deletions?: number;
  provider?: string;
  model?: string;
}

export interface ReviewFormattingResult {
  summary: string;
  concerns: string[];
  recommendation: string;
  confidence: number;
}

/**
 * Pretty-print a code review result to the terminal.
 */
export function displayReview(
  num: number,
  title: string,
  result: ReviewFormattingResult,
  meta?: ReviewFormattingMetadata,
): void {
  console.log(chalk.bold(`\n  #${num}: ${sanitizeTitle(title)}`));
  if (meta?.author) console.log(`  Author: ${meta.author} | ${meta.additions ?? "?"}+/${meta.deletions ?? "?"}−`);
  if (meta?.provider) console.log(chalk.dim(`  Reviewed with ${meta.provider}/${meta.model}`));
  console.log();
  console.log(chalk.bold("  Summary:"), result.summary);
  if (result.concerns.length > 0) {
    console.log(chalk.bold("\n  Concerns:"));
    for (const c of result.concerns) {
      console.log(`    - ${c}`);
    }
  }
  const recColor =
    result.recommendation === "merge" ? chalk.green : result.recommendation === "revise" ? chalk.yellow : chalk.red;
  console.log(chalk.bold("\n  Recommendation:"), recColor(result.recommendation.toUpperCase()));
  console.log(chalk.bold("  Confidence:"), `${(result.confidence * 100).toFixed(0)}%`);
}
