import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { getRepos, loadConfig, loadEnvConfig, parseRepo } from "../../config.js";
import { checkEmbeddingReachability } from "../../doctor.js";
import { GitHubClient } from "../../github.js";
import { VectorStore } from "../../store.js";
import { getDatabasePath } from "../shared/paths.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check configuration, providers, and database health")
    .option("--json", "Output results as JSON")
    .action(async (opts) => {
      const checks: Array<{ name: string; status: "pass" | "fail" | "warn"; detail: string }> = [];

      const pass = (name: string, detail: string) => checks.push({ name, status: "pass", detail });
      const fail = (name: string, detail: string) => checks.push({ name, status: "fail", detail });
      const warn = (name: string, detail: string) => checks.push({ name, status: "warn", detail });

      // 1. Config valid
      let config: ReturnType<typeof loadConfig> | null = null;
      try {
        config = loadConfig();
        const configRepos = getRepos(config);
        pass(
          "config",
          `prism.config.yaml valid (${configRepos.length} repo${configRepos.length > 1 ? "s" : ""}: ${configRepos.slice(0, 3).join(", ")}${configRepos.length > 3 ? "..." : ""})`,
        );
      } catch (e: any) {
        fail("config", e.message);
      }

      // 2. Env valid + GitHub token
      let env: ReturnType<typeof loadEnvConfig> | null = null;
      try {
        env = loadEnvConfig();
        pass("env", ".env loaded");
      } catch (e: any) {
        fail("env", e.message);
      }

      // 3. GitHub token works
      if (env && config) {
        try {
          const { owner, repo } = parseRepo(getRepos(config)[0]);
          const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
          await github.fetchPRs({ maxItems: 1 });
          const rl = github.getRateLimit();
          pass("github", `Token valid (${rl.remaining}/${rl.limit} API calls remaining)`);
        } catch (e: any) {
          if (e.status === 401) {
            fail("github", "Token invalid or expired. Generate at https://github.com/settings/tokens");
          } else if (e.status === 403) {
            fail("github", "Token lacks required scopes. Needs `repo` for private repos, `public_repo` for public");
          } else if (e.status === 404) {
            fail("github", `Repository ${getRepos(config)[0]} not found or not accessible with this token`);
          } else {
            fail("github", e.message || "Unknown error checking GitHub token");
          }
        }
      }

      // 4. Embedding provider reachable
      if (env) {
        const embeddingCheck = await checkEmbeddingReachability({
          provider: env.EMBEDDING_PROVIDER,
          apiKey: env.EMBEDDING_API_KEY,
          model: env.EMBEDDING_MODEL,
          baseUrl: env.EMBEDDING_BASE_URL,
          dimensions: env.EMBEDDING_DIMENSIONS,
        });
        if (embeddingCheck.status === "pass") pass(embeddingCheck.name, embeddingCheck.detail);
        else fail(embeddingCheck.name, embeddingCheck.detail);
      }

      // 5. LLM provider reachable (just check config, don't make a full call)
      if (env) {
        if (env.LLM_API_KEY || env.LLM_PROVIDER === "ollama" || env.LLM_PROVIDER === "opencode") {
          pass("llm", `${env.LLM_PROVIDER} (${env.LLM_MODEL})`);
        } else {
          warn("llm", `${env.LLM_PROVIDER} configured but no LLM_API_KEY set`);
        }
      }

      // 6. DB exists + sqlite-vec loads
      const dbPath = getDatabasePath();
      if (existsSync(dbPath)) {
        try {
          const store = new VectorStore(undefined, undefined);
          const firstRepo = config ? getRepos(config)[0] : "";
          const repoFull = firstRepo ? `${parseRepo(firstRepo).owner}/${parseRepo(firstRepo).repo}` : "";

          if (repoFull) {
            const stats = store.getStats(repoFull);
            pass(
              "database",
              `${stats.totalItems} items (${stats.prs} PRs, ${stats.issues} issues, ${stats.diffs} diffs)`,
            );

            // 7. Embedding dimensions + model match
            const storedModel = store.getMeta("embedding_model");
            const storedDims = store.getMeta("embedding_dimensions");
            const lastEmbed = store.getMeta("last_embed_date");

            if (storedModel && env && storedModel !== env.EMBEDDING_MODEL) {
              warn(
                "model",
                `DB has ${storedModel} but .env specifies ${env.EMBEDDING_MODEL}. Run \`prism re-embed\` to update`,
              );
            } else if (storedModel) {
              pass("model", `${storedModel} (${storedDims} dims)`);
            }

            if (lastEmbed) {
              pass("last_embed", `Last embedded: ${lastEmbed.slice(0, 10)}`);
            }

            // Embedding coverage
            const embeddedCount = store.getAllEmbeddings(repoFull).size;
            const coverage = stats.totalItems > 0 ? ((embeddedCount / stats.totalItems) * 100).toFixed(0) : "0";
            if (embeddedCount < stats.totalItems) {
              warn("coverage", `${embeddedCount}/${stats.totalItems} items embedded (${coverage}%)`);
            } else {
              pass("coverage", `${embeddedCount}/${stats.totalItems} items embedded (${coverage}%)`);
            }
          } else {
            pass("database", "Database exists and sqlite-vec loaded");
          }

          store.close();
        } catch (e: any) {
          fail("database", e.message);
        }
      } else {
        warn("database", "No database found. Run `prism scan` to create one");
      }

      // Output
      if (opts.json) {
        console.log(JSON.stringify({ command: "doctor", checks }));
        return;
      }

      console.log(chalk.bold("\nprism doctor\n"));
      for (const check of checks) {
        const icon =
          check.status === "pass" ? chalk.green("✓") : check.status === "fail" ? chalk.red("✗") : chalk.yellow("⚠");
        console.log(`  ${icon} ${check.name}: ${check.detail}`);
      }

      const failures = checks.filter((c) => c.status === "fail");
      const warnings = checks.filter((c) => c.status === "warn");
      console.log();
      if (failures.length === 0 && warnings.length === 0) {
        console.log(chalk.green("  all checks passed"));
      } else if (failures.length > 0) {
        console.log(chalk.red(`  ${failures.length} check(s) failed`));
      }
    });
}
