import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { getRepos, loadConfig, loadEnvConfig, parseRepo } from "../../config.js";
import { GitHubClient } from "../../github.js";
import {
  applyEmbeddingKey,
  detectRepoFromGit,
  injectRepoIntoConfig,
  resolveInitRepo,
  verifyInit,
  verifyInitEmbedding,
} from "../../init.js";
import { getPackageRoot } from "../shared/paths.js";
import { askQuestion } from "../shared/prompts.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize pr-prism configuration in current directory")
    .option("-r, --repo <owner/repo>", "target repo to wire into the config (defaults to the git origin remote)")
    .option("-y, --yes", "non-interactive: skip prompts, leave the repo unresolved if undetectable")
    .option("--no-verify", "skip the post-init connectivity checks")
    .action(async (opts) => {
      const packageRoot = getPackageRoot();
      const envExample = resolve(packageRoot, ".env.example");
      const configExample = resolve(packageRoot, "prism.config.yaml");

      if (!existsSync(".env") && existsSync(envExample)) {
        copyFileSync(envExample, ".env");
        console.log(`${chalk.green("✓")} Created .env (edit with your API keys)`);
      } else if (existsSync(".env")) {
        console.log(`${chalk.yellow("⊘")} .env already exists`);
      }

      if (!existsSync("prism.config.yaml") && existsSync(configExample)) {
        copyFileSync(configExample, "prism.config.yaml");
        console.log(`${chalk.green("✓")} Created prism.config.yaml (edit repo and settings)`);
      } else if (existsSync("prism.config.yaml")) {
        console.log(`${chalk.yellow("⊘")} prism.config.yaml already exists`);
      }

      // Wire the config to a real repo (flag > git origin > prompt) so scan/dupes work
      // out of the box instead of choking on the `repo: owner/repo` placeholder.
      const resolvedRepo = await resolveInitRepo({
        repoFlag: opts.repo,
        detect: (cwd) => detectRepoFromGit(cwd),
        cwd: process.cwd(),
        interactive: !opts.yes,
        ask: (question) => askQuestion(question),
      });
      if (resolvedRepo && existsSync("prism.config.yaml")) {
        const yaml = readFileSync("prism.config.yaml", "utf-8");
        if (yaml.includes("repo: owner/repo")) {
          writeFileSync("prism.config.yaml", injectRepoIntoConfig(yaml, resolvedRepo));
          console.log(`${chalk.green("✓")} wired config to ${chalk.bold(resolvedRepo)}`);
        }
      }

      // Full auto-detection of available providers
      let ollamaRunning = false;
      let ollamaEmbedModels: string[] = [];
      let ollamaLLMModels: string[] = [];
      const embeddingModelPrefixes = [
        "nomic-embed",
        "qwen3-embedding",
        "mxbai-embed",
        "all-minilm",
        "snowflake-arctic-embed",
      ];
      const llmModelPrefixes = ["llama", "qwen", "mistral", "gemma", "phi", "deepseek"];

      try {
        const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
        if (resp.ok) {
          ollamaRunning = true;
          const data = (await resp.json()) as any;
          const models: string[] = (data.models || []).map((m: any) => m.name as string);
          ollamaEmbedModels = models.filter((m) => embeddingModelPrefixes.some((p) => m.startsWith(p)));
          ollamaLLMModels = models.filter((m) => llmModelPrefixes.some((p) => m.startsWith(p)));
        }
      } catch {
        /* ollama not running */
      }

      // Detect API keys in environment
      const detectedKeys: Array<{ name: string; envVar: string; provider: string }> = [];
      const keyChecks = [
        { envVar: "JINA_API_KEY", name: "Jina", provider: "jina" },
        { envVar: "OPENAI_API_KEY", name: "OpenAI", provider: "openai" },
        { envVar: "VOYAGE_API_KEY", name: "Voyage AI", provider: "voyageai" },
        { envVar: "ANTHROPIC_API_KEY", name: "Anthropic", provider: "anthropic" },
        { envVar: "KIMI_API_KEY", name: "Kimi", provider: "kimi" },
      ];
      for (const check of keyChecks) {
        if (process.env[check.envVar]) detectedKeys.push(check);
      }

      console.log(`\n${chalk.bold("provider detection:")}`);

      // Embedding provider recommendation
      let bestEmbedding: { provider: string; model: string } | null = null;

      if (ollamaEmbedModels.length > 0) {
        const preferred = ollamaEmbedModels.find((m) => m.startsWith("nomic-embed")) || ollamaEmbedModels[0];
        console.log(chalk.green(`  embedding: ollama (${ollamaEmbedModels.join(", ")})`));
        bestEmbedding = { provider: "ollama", model: preferred };
      } else if (ollamaRunning) {
        console.log(chalk.yellow("  ollama running but no embedding model found"));
        console.log(chalk.dim("    recommended: ollama pull nomic-embed-text"));
      }

      if (detectedKeys.length > 0) {
        for (const key of detectedKeys) {
          console.log(chalk.green(`  detected: ${key.name} (${key.envVar})`));
        }
        if (!bestEmbedding) {
          const jinaKey = detectedKeys.find((k) => k.provider === "jina");
          const openaiKey = detectedKeys.find((k) => k.provider === "openai");
          if (jinaKey) bestEmbedding = { provider: "jina", model: "jina-embeddings-v3" };
          else if (openaiKey) bestEmbedding = { provider: "openai", model: "text-embedding-3-small" };
        }
      }

      // LLM provider recommendation
      let bestLLM: { provider: string; model: string } | null = null;
      if (ollamaLLMModels.length > 0) {
        console.log(
          chalk.green(
            `  llm: ollama (${ollamaLLMModels.slice(0, 3).join(", ")}${ollamaLLMModels.length > 3 ? "..." : ""})`,
          ),
        );
        bestLLM = { provider: "ollama", model: ollamaLLMModels[0] };
      }
      // OpenCode Zen is always free, no key needed
      if (!bestLLM) {
        bestLLM = { provider: "opencode", model: "opencode/gpt-4o-mini" };
        console.log(chalk.green("  llm: opencode zen (free, no key needed)"));
      }

      if (!bestEmbedding && detectedKeys.length === 0 && !ollamaRunning) {
        console.log(chalk.yellow("  no providers detected"));
        console.log();
        console.log(chalk.bold("  zero-cost setup (recommended):"));
        console.log("  1. get a free Jina API key at https://jina.ai");
        console.log("  2. set EMBEDDING_PROVIDER=jina and EMBEDDING_API_KEY in .env");
        console.log("  3. LLM_PROVIDER=opencode works out of the box (free)");
        console.log();
        console.log(chalk.bold("  local setup (no API keys needed):"));
        console.log("  1. install ollama: https://ollama.com");
        console.log("  2. ollama pull nomic-embed-text");
        console.log("  3. set EMBEDDING_PROVIDER=ollama in .env");
      }

      // Auto-fill .env with best detected provider
      if (bestEmbedding) {
        const envPath = resolve(process.cwd(), ".env");
        if (existsSync(envPath)) {
          let content = readFileSync(envPath, "utf-8");
          content = content.replace(/^EMBEDDING_PROVIDER=.*/m, `EMBEDDING_PROVIDER=${bestEmbedding.provider}`);
          content = content.replace(/^EMBEDDING_MODEL=.*/m, `EMBEDDING_MODEL=${bestEmbedding.model}`);
          if (bestLLM) {
            content = content.replace(/^LLM_PROVIDER=.*/m, `LLM_PROVIDER=${bestLLM.provider}`);
            content = content.replace(/^LLM_MODEL=.*/m, `LLM_MODEL=${bestLLM.model}`);
          }
          // A detected cloud embedding provider needs its key written too, or it
          // silently can't authenticate. ollama has no key -> applyEmbeddingKey no-ops.
          const embKey = detectedKeys.find((k) => k.provider === bestEmbedding.provider);
          content = applyEmbeddingKey(content, embKey ? (process.env[embKey.envVar] ?? null) : null);
          writeFileSync(envPath, content);
          console.log(
            chalk.dim(`\n  pre-filled .env with ${bestEmbedding.provider} + ${bestLLM?.provider || "opencode"}`),
          );
        }
      }

      // Check for GitHub token
      const hasGithubToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
      if (hasGithubToken) {
        console.log(chalk.green("\n  detected: GitHub token in environment"));
      }

      // Verify the setup end to end (config + env + github + embedding), unless --no-verify.
      if (opts.verify !== false) {
        console.log(`\n${chalk.bold("verifying setup:")}`);
        const checks = await verifyInit({
          loadConfig: () => loadConfig(),
          loadEnvConfig: () => loadEnvConfig(),
          network: !!resolvedRepo,
          fetchSample: async () => {
            const cfg = loadConfig();
            const en = loadEnvConfig();
            const { owner, repo } = parseRepo(getRepos(cfg)[0]);
            await new GitHubClient(en.GITHUB_TOKEN, owner, repo).fetchPRs({ maxItems: 1 });
          },
          checkEmbedding: async () => {
            const en = loadEnvConfig();
            return verifyInitEmbedding({
              provider: en.EMBEDDING_PROVIDER,
              apiKey: en.EMBEDDING_API_KEY,
              model: en.EMBEDDING_MODEL,
              baseUrl: en.EMBEDDING_BASE_URL,
              dimensions: en.EMBEDDING_DIMENSIONS,
            });
          },
        });
        for (const ch of checks) {
          const icon =
            ch.status === "pass" ? chalk.green("✓") : ch.status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
          console.log(`  ${icon} ${ch.name}${ch.detail ? chalk.dim(` — ${ch.detail}`) : ""}`);
        }
      }

      console.log(`\n${chalk.bold("next steps:")}`);
      const steps: string[] = [];
      if (!hasGithubToken) steps.push("Add your GitHub token to .env (GITHUB_TOKEN=ghp_...)");
      if (!resolvedRepo) steps.push("Set your target repo in prism.config.yaml (or re-run with --repo owner/repo)");
      steps.push("Run: prism doctor && prism scan");
      steps.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s}`);
      });
    });
}
