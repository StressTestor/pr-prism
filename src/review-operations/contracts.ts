import { createHash } from "node:crypto";
import { z } from "zod";
import type { FileSource } from "./integrity.js";

export type Kind = "pr" | "issue";
export type State =
  | "pending"
  | "active"
  | "completed_current"
  | "partial"
  | "failed"
  | "stale"
  | "externally_resolved"
  | "blocked"
  | "paused";
export const PROMPT = "prism-operations-v5-1";
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface Evidence {
  repo: string;
  kind: Kind;
  number: number;
  state: "open" | "closed" | "merged";
  title: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  head?: string;
  base?: string;
  draft?: boolean;
  labels: string[];
  comments: unknown[];
  events: unknown[];
  files: {
    path: string;
    patch?: string;
    previousPath?: string;
    status: string;
    source?: FileSource;
    objectSha?: string;
  }[];
  coverage?: { version: 1; expectedFiles: number; mergeBase: string; manifestHash: string };
  limitations: string[];
  observedAt: string;
  inventoryOnly?: true;
  health?: {
    metadataHash?: string;
    remaining: string | null;
    reset: string | null;
    probes?: { route: string; digest: string; etag?: string | null }[];
  };
}
export const fingerprint = (e: Evidence): string => hash({ ...e, observedAt: undefined, health: undefined });
export interface Batch {
  index: number;
  path: string | null;
  offset: number;
  text: string;
  hash: string;
}
// Every character is retained, including long lines, whitespace and source control characters.
// JSON framing keeps the evidence separate from the system instruction.
export function batches(e: Evidence, bound = 22000): Batch[] {
  if (!Number.isSafeInteger(bound) || bound < 100) throw new Error("Invalid batch bound");
  const parts = [
    {
      path: null as string | null,
      text: JSON.stringify({
        ...e,
        files: undefined,
        observedAt: undefined,
        health: undefined,
        fileInventory: e.coverage
          ? e.files.map(({ patch: _patch, source: _source, ...metadata }) => metadata)
          : undefined,
      }),
    },
    ...e.files
      .filter((f) => f.patch !== undefined || f.source !== undefined)
      .map((f) => ({ path: f.path as string | null, text: f.source ? JSON.stringify(f) : f.patch! })),
  ];
  const result: Batch[] = [];
  for (const part of parts) {
    for (let offset = 0; offset < Math.max(1, part.text.length); offset += bound) {
      const text = part.text.slice(offset, offset + bound);
      result.push({
        index: result.length,
        path: part.path,
        offset,
        text,
        hash: hash({ path: part.path, offset, text }),
      });
    }
  }
  return result;
}
const resultSchema = z
  .object({
    summary: z.string().min(1),
    category: z.enum([
      "human_review",
      "actionable",
      "needs_reproduction",
      "needs_info",
      "duplicate_candidate",
      "linked_fix_candidate",
    ]),
    findings: z.array(
      z
        .object({
          file: z.string().nullable(),
          severity: z.enum(["critical", "high", "medium", "low"]),
          explanation: z.string().min(1),
          evidenceHash: z.string(),
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          uncertainty: z.string().min(1),
        })
        .strict(),
    ),
    uncertainty: z.array(z.string()),
  })
  .strict();
export function validateResult(value: unknown, batch: Batch) {
  const result = resultSchema.parse(value);
  for (const f of result.findings) {
    if (f.file !== batch.path || f.evidenceHash !== batch.hash || f.start >= f.end || f.end > batch.text.length) {
      throw new Error("Finding is not linked to supplied evidence offsets and file");
    }
  }
  return {
    ...result,
    unverified: true as const,
    recommendations: {
      blocked_by: [
        "independent_source_and_test_verification",
        "fresh_CI_and_repository_rules",
        "explicit_item_confirmation",
      ],
      quick_fix_candidate: false,
      confidence: "unverified",
    },
  };
}
export interface Source {
  inventory(repo: string, kind: Kind): Promise<number[]>;
  metadata?(repo: string, kind: Kind, number: number): Promise<Evidence>;
  changes?(repo: string, kind: Kind, since: string): Promise<number[]>;
  probe?(evidence: Evidence): Promise<boolean>;
  get(repo: string, kind: Kind, number: number): Promise<Evidence>;
}
export interface Account {
  id: string;
  model: string;
  endpoint: string;
  keyEnv: string;
  leaseKey?: string;
}
export interface ModelResult {
  value: unknown;
  latencyMs?: number;
  spend?: number;
}
export type Model = (account: Account, evidence: Evidence, batch: Batch, signal?: AbortSignal) => Promise<ModelResult>;
export const modelFingerprint = (a: Account): string => hash({ model: a.model, endpoint: a.endpoint, prompt: PROMPT });
