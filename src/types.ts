export interface PRItem {
  number: number;
  type: "pr" | "issue";
  repo: string;
  title: string;
  body: string;
  state: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  // PR-specific
  diffUrl?: string;
  ciStatus?: "success" | "failure" | "pending" | "unknown";
  reviewCount?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  hasMergeConflicts?: boolean;
  hasTests?: boolean;
}

export interface ScoredPR extends PRItem {
  score: number;
  signals: ScoreSignals;
}

export interface ScoreSignals {
  hasTests: number;
  ciPassing: number;
  diffSize: number;
  authorHistory: number;
  descriptionQuality: number;
  reviewApprovals: number;
  recency: number;
}

export interface Cluster {
  id: number;
  items: ScoredPR[];
  bestPick: ScoredPR;
  avgSimilarity: number;
  theme: string;
}

export interface ReviewResult {
  summary: string;
  concerns: string[];
  recommendation: "merge" | "revise" | "close";
  confidence: number;
}

export interface VisionScore {
  prNumber: number;
  score: number;
  classification: "aligned" | "drifting" | "off-vision";
  matchedSection: string;
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: Date;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

export interface LLMProvider {
  complete(prompt: string, systemPrompt?: string): Promise<string>;
  completeJSON<T>(prompt: string, systemPrompt?: string): Promise<T>;
}

export interface StoreItem {
  id: string;
  type: "pr" | "issue";
  number: number;
  repo: string;
  title: string;
  bodySnippet: string;
  embedding: Float32Array;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
