// Public API — pipeline functions for programmatic use

export type { PipelineContext } from "./cli.js";
export { createPipelineContext, parseDuration, runDupes, runRank, runScan, runVision } from "./cli.js";
export { findDuplicateClusters } from "./cluster.js";
export { loadConfig, loadEnvConfig, parseRepo } from "./config.js";
export { createEmbeddingProvider, prepareEmbeddingText } from "./embeddings.js";
export { GitHubClient } from "./github.js";
export { buildScorerContext, rankPRs, scorePR } from "./scorer.js";
export { cosineSimilarity, isZeroVector } from "./similarity.js";
export { VectorStore } from "./store.js";
export type {
  Cluster,
  EmbeddingProvider,
  PRItem,
  RateLimitInfo,
  ScoredPR,
  ScoreSignals,
  StoreItem,
  VisionScore,
} from "./types.js";
export { checkVisionAlignment, loadAndEmbedVisionDoc, scoreVisionAlignment } from "./vision.js";
