import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { config as loadEnv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ScoringWeightsSchema = z.object({
  has_tests: z.number().default(0.25),
  ci_passing: z.number().default(0.20),
  diff_size_penalty: z.number().default(0.15),
  author_history: z.number().default(0.15),
  description_quality: z.number().default(0.15),
  review_approvals: z.number().default(0.10),
});

const ThresholdsSchema = z.object({
  duplicate_similarity: z.number().default(0.85),
  aligned: z.number().default(0.65),
  drifting: z.number().default(0.40),
});

const LabelsSchema = z.object({
  duplicate: z.string().default("prism:duplicate"),
  aligned: z.string().default("prism:aligned"),
  drifting: z.string().default("prism:drifting"),
  off_vision: z.string().default("prism:off-vision"),
  top_pick: z.string().default("prism:top-pick"),
});

const ConfigSchema = z.object({
  repo: z.string(),
  vision_doc: z.string().optional(),
  thresholds: ThresholdsSchema.optional().transform(v => ThresholdsSchema.parse(v ?? {})),
  scoring: z.object({ weights: ScoringWeightsSchema.optional().transform(v => ScoringWeightsSchema.parse(v ?? {})) }).optional().transform(v => v ?? { weights: ScoringWeightsSchema.parse({}) }),
  labels: LabelsSchema.optional().transform(v => LabelsSchema.parse(v ?? {})),
  batch_size: z.number().default(50),
  max_prs: z.number().default(5000),
});

export type PrismConfig = z.infer<typeof ConfigSchema>;

const EnvSchema = z.object({
  GITHUB_TOKEN: z.string(),
  EMBEDDING_PROVIDER: z.enum(["openai", "kimi", "ollama", "voyageai", "jina"]).default("openai"),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  LLM_PROVIDER: z.enum(["openai", "kimi", "anthropic", "ollama", "opencode"]).default("openai"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function loadConfig(configPath?: string): PrismConfig {
  const p = configPath || resolve(process.cwd(), "prism.config.yaml");
  if (!existsSync(p)) {
    throw new Error(`Config file not found: ${p}`);
  }
  const raw = parseYaml(readFileSync(p, "utf-8"));
  return ConfigSchema.parse(raw);
}

export function loadEnvConfig(envPath?: string): EnvConfig {
  loadEnv({ path: envPath || resolve(process.cwd(), ".env") });
  return EnvSchema.parse(process.env);
}

export function parseRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  return { owner, repo: name };
}
