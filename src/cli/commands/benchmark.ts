import type { Command } from "commander";
import { parseBenchmarkDimensions, runBenchmark } from "../../benchmark.js";

export function registerBenchmarkCommand(program: Command): void {
  program
    .command("benchmark")
    .description("Compare embedding models for duplicate detection quality and speed")
    .option("-r, --repo <owner/repo>", "Repository to benchmark against")
    .option("--provider <provider>", "Embedding provider (defaults to Ollama)")
    .option("--base-url <url>", "OpenAI-compatible base URL (falls back to EMBEDDING_BASE_URL)")
    .option(
      "--dimensions <integer>",
      "Output dimensions (falls back to EMBEDDING_DIMENSIONS)",
      parseBenchmarkDimensions,
    )
    .option("--models <models>", "Comma-separated embedding models to compare", "nomic-embed-text,qwen3-embedding:0.6b")
    .option("--thresholds <thresholds>", "Comma-separated similarity thresholds", "0.82,0.85")
    .option("--out <path>", "Results file for this run (default: data/benchmark-results.json)")
    .option("--include-bot-authors", "Cluster bot-authored items too (excluded by default)")
    .action(async (opts) => {
      await runBenchmark({
        repo: opts.repo,
        provider: opts.provider,
        baseUrl: opts.baseUrl,
        dimensions: opts.dimensions,
        models: opts.models,
        thresholds: opts.thresholds,
        out: opts.out,
        includeBotAuthors: opts.includeBotAuthors,
      });
    });
}
