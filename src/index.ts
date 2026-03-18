// Public API — pipeline functions for programmatic use

export { computeClusterOverlap, runBenchmark } from "./benchmark.js";
export { findDuplicateClusters } from "./cluster.js";
export { getRepos, getVisionDoc, loadConfig, loadEnvConfig, parseRepo } from "./config.js";
export { createEmbeddingProvider, prepareEmbeddingText } from "./embeddings.js";
export { classifyFetchError, classifyHttpError, ProviderError } from "./errors.js";
export { GitHubClient } from "./github.js";
export type { PipelineContext } from "./pipeline.js";
export {
  createPipelineContext,
  parseDuration,
  resolveRepos,
  runCompare,
  runDupes,
  runDupesMulti,
  runRank,
  runScan,
  runVision,
} from "./pipeline.js";
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
