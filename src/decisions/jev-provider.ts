import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  choice,
  noul,
  RateLimitError,
  type RetryPolicy,
  score,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import { ProviderError } from "../errors.js";
import { computeDecisionIdentity, computeRubricHash, computeStateHash } from "./sanitize.js";
import type {
  ChoiceQuestionDef,
  DecisionAnswer,
  DecisionProvider,
  DecisionQuestions,
  DecisionRequest,
  DecisionRequestOptions,
  DecisionResult,
  NoulQuestionDef,
  ScoreQuestionDef,
} from "./types.js";
import { validateDecisionAnswer } from "./validation.js";

export interface JevProviderConfig {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export const DEFAULT_JEV_MODEL = "jev-1.14.0";
const DEFAULT_TIMEOUT_MS = 10000;

export class JevDecisionProvider implements DecisionProvider {
  readonly id = "jev";
  readonly defaultModel: string;
  private apiKey: string;
  private baseURL?: string;
  private timeoutMs: number;
  private retry?: Partial<RetryPolicy>;
  private customFetch?: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(config: JevProviderConfig = {}) {
    const key = config.apiKey || process.env.TYPESAFE_API_KEY;
    if (!key) {
      throw new ProviderError(
        "Jev",
        "API key missing",
        "Set TYPESAFE_API_KEY in your environment or .env file to enable Jev decisions.",
      );
    }
    this.apiKey = key;
    this.baseURL = config.baseURL || process.env.TYPESAFE_BASE_URL;
    this.defaultModel = config.defaultModel || process.env.DECISION_MODEL || DEFAULT_JEV_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = config.retry;
    this.customFetch = config.fetch;
  }

  async evaluate<Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
    options: DecisionRequestOptions = {},
  ): Promise<DecisionResult<Q>> {
    if (!request.questions || Object.keys(request.questions).length === 0) {
      throw new ProviderError("Jev", "No questions provided", "Provide at least one question to evaluate.");
    }

    const state = request.state;
    if (state === null || state === undefined || (typeof state === "string" && state.trim().length === 0)) {
      throw new ProviderError("Jev", "Empty state provided", "Provide non-empty state to evaluate.");
    }

    const inputHash = computeStateHash(state);
    const schemaVersion = request.schemaVersion || "1.0.0";
    const rubricHash = computeRubricHash(request.questions, schemaVersion);
    const timeout = options.timeoutMs ?? this.timeoutMs;
    const model = request.model || this.defaultModel;

    // Convert our DecisionQuestions to @typesafe-ai/sdk question descriptors
    const sdkQuestions: Record<string, any> = {};
    for (const [name, q] of Object.entries(request.questions)) {
      switch (q.type) {
        case "choice": {
          const cq = q as ChoiceQuestionDef;
          sdkQuestions[name] = choice(cq.instructions, cq.criteria);
          break;
        }
        case "score": {
          const sq = q as ScoreQuestionDef;
          if (!Array.isArray(sq.criteria) || sq.criteria.length < 2) {
            throw new ProviderError(
              "Jev",
              `Question "${name}" invalid`,
              "Score question must have at least 2 rubric criteria levels.",
            );
          }
          sdkQuestions[name] = score(sq.instructions, sq.criteria as [string, string, ...string[]]);
          break;
        }
        case "noul": {
          const nq = q as NoulQuestionDef;
          sdkQuestions[name] = noul(nq.instructions, nq.criteria ?? undefined);
          break;
        }
        default:
          throw new ProviderError(
            "Jev",
            `Unsupported question type: ${(q as any)?.type}`,
            "Supported primitives are 'choice', 'score', and 'noul'.",
          );
      }
    }

    const client = new TypeSafeClient({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      defaultModel: model,
      timeout,
      retry: this.retry,
      fetch: this.customFetch,
    });

    const startTime = performance.now();

    let rawResult: any;
    try {
      rawResult = await client.systemOne(
        {
          state: state as any,
          questions: sdkQuestions,
          model,
        },
        {
          signal: options.signal,
          timeout,
        },
      );
    } catch (err: any) {
      throw this.translateError(err);
    }

    const latencyMs = Math.round(performance.now() - startTime);

    if (!rawResult || typeof rawResult !== "object" || !rawResult.answers) {
      throw new ProviderError(
        "Jev",
        "Invalid response from model (missing answers payload)",
        "The model response did not contain an answers object.",
      );
    }

    // P1-3: Strict validation for Choice, Score, and Noul answers
    const answers: Record<string, DecisionAnswer> = {};
    for (const [name, q] of Object.entries(request.questions)) {
      const rawAns = Object.hasOwn(rawResult.answers, name) ? rawResult.answers[name] : undefined;
      answers[name] = validateDecisionAnswer(name, q, rawAns, "Jev");
    }

    const resolvedModel = rawResult.model || model;
    const decisionIdentity = computeDecisionIdentity({
      inputHash,
      rubricHash,
      model: resolvedModel,
      schemaVersion,
    });

    return {
      answers: answers as any,
      provenance: {
        provider: "jev",
        model: resolvedModel,
        inputHash,
        decisionSchemaVersion: schemaVersion,
        rubricHash,
        decisionIdentity,
        usage: {
          inputTokens: rawResult.usage?.input_tokens ?? null,
          outputTokens: rawResult.usage?.output_tokens ?? null,
        },
        latencyMs,
        evaluatedAt: new Date().toISOString(),
      },
    };
  }

  private translateError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;

    if (err instanceof AuthenticationError) {
      return new ProviderError(
        "Jev",
        "Authentication failed (401)",
        "Verify your TYPESAFE_API_KEY at https://console.typesafe.ai/keys",
        401,
      );
    }

    if (err instanceof RateLimitError) {
      const retryMs = err.retryAfterMs;
      const remedy = retryMs
        ? `Rate limit exceeded. Retry after ${Math.ceil(retryMs / 1000)}s`
        : "Rate limit exceeded. Check your plan at https://console.typesafe.ai/rate-limits";
      return new ProviderError("Jev", "Rate limit exceeded (429)", remedy, 429);
    }

    if (err instanceof APITimeoutError) {
      return new ProviderError(
        "Jev",
        `Request timed out after ${err.timeoutMs}ms`,
        "Increase timeout or check network latency to api.typesafe.ai",
        408,
      );
    }

    if (err instanceof APIConnectionError) {
      return new ProviderError(
        "Jev",
        "Connection failed to TypeSafe API",
        "Check internet connection and verify api.typesafe.ai is reachable",
      );
    }

    if (err instanceof APIError) {
      return new ProviderError(
        "Jev",
        `API error (${err.status}): ${err.message}`,
        "Check request payload and model parameters",
        err.status,
      );
    }

    if (err instanceof TypeSafeError) {
      return new ProviderError("Jev", `SDK error: ${err.message}`, "Check request formatting and arguments");
    }

    const msg = (err as any)?.message || String(err);
    return new ProviderError("Jev", `Unexpected error: ${msg}`, "Check configuration and try again");
  }
}
