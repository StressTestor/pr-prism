import { ProviderError } from "../errors.js";
import { computeDecisionIdentity, computeRubricHash, computeStateHash } from "./sanitize.js";
import type {
  ChoiceAnswer,
  ChoiceQuestionDef,
  DecisionAnswer,
  DecisionProvider,
  DecisionQuestions,
  DecisionRequest,
  DecisionRequestOptions,
  DecisionResult,
  NoulAnswer,
  ScoreAnswer,
  ScoreQuestionDef,
} from "./types.js";

export interface MockProviderOptions {
  model?: string;
  presetAnswers?: Record<string, DecisionAnswer>;
  /** When true, only answers explicitly present in presetAnswers are returned without auto-generating fallbacks. */
  exactPresetAnswers?: boolean;
  simulateError?: "unauthorized" | "rate_limit" | "timeout" | "connection" | "invalid_response";
  latencyMs?: number;
}

export class MockDecisionProvider implements DecisionProvider {
  readonly id = "mock";
  readonly defaultModel: string;
  private options: MockProviderOptions;

  constructor(options: MockProviderOptions = {}) {
    this.defaultModel = options.model || "mock-jev-1.14.0";
    this.options = options;
  }

  setPresetAnswers(answers: Record<string, DecisionAnswer>) {
    this.options.presetAnswers = answers;
  }

  setSimulateError(err: MockProviderOptions["simulateError"]) {
    this.options.simulateError = err;
  }

  async evaluate<Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
    _options?: DecisionRequestOptions,
  ): Promise<DecisionResult<Q>> {
    if (this.options.simulateError) {
      switch (this.options.simulateError) {
        case "unauthorized":
          throw new ProviderError("Jev", "Authentication failed (401)", "Verify your TYPESAFE_API_KEY", 401);
        case "rate_limit":
          throw new ProviderError("Jev", "Rate limit exceeded (429)", "Retry after backoff", 429);
        case "timeout":
          throw new ProviderError("Jev", "Request timed out after 10000ms", "Increase timeout", 408);
        case "connection":
          throw new ProviderError("Jev", "Connection failed to TypeSafe API", "Check internet connection");
        case "invalid_response":
          throw new ProviderError("Jev", "Invalid response from model", "The model response was corrupted");
      }
    }

    const state = request.state;
    if (state === null || state === undefined || (typeof state === "string" && state.trim().length === 0)) {
      throw new ProviderError("Mock", "Empty state provided", "Provide non-empty state to evaluate.");
    }

    const inputHash = computeStateHash(state);
    const schemaVersion = request.schemaVersion || "1.0.0";
    const rubricHash = computeRubricHash(request.questions, schemaVersion);
    const model = request.model || this.defaultModel;
    const decisionIdentity = computeDecisionIdentity({
      inputHash,
      rubricHash,
      model,
      schemaVersion,
    });

    const answers: Record<string, DecisionAnswer> = {};

    for (const [name, q] of Object.entries(request.questions)) {
      if (this.options.presetAnswers && Object.hasOwn(this.options.presetAnswers, name)) {
        answers[name] = this.options.presetAnswers[name];
        continue;
      }

      if (this.options.exactPresetAnswers) {
        continue;
      }

      switch (q.type) {
        case "choice": {
          const cq = q as ChoiceQuestionDef;
          const keys = Object.keys(cq.criteria);
          const chosen = keys[0] || "other";
          const probs: Record<string, number> = {};
          for (const k of keys) {
            probs[k] = k === chosen ? 0.9 : 0.1 / Math.max(1, keys.length - 1);
          }
          const ans: ChoiceAnswer = {
            type: "choice",
            choice: chosen,
            confidence: 0.9,
            probabilities: probs,
          };
          answers[name] = ans;
          break;
        }
        case "score": {
          const sq = q as ScoreQuestionDef;
          const levels = sq.criteria.length;
          const mid = Math.min(1, levels - 1);
          const probs: Record<string, number> = {};
          for (let i = 0; i < levels; i++) {
            probs[String(i)] = i === mid ? 0.8 : 0.2 / Math.max(1, levels - 1);
          }
          const ans: ScoreAnswer = {
            type: "score",
            score: mid,
            confidence: 0.85,
            probabilities: probs,
          };
          answers[name] = ans;
          break;
        }
        case "noul": {
          const ans: NoulAnswer = {
            type: "noul",
            noul: 0.1,
          };
          answers[name] = ans;
          break;
        }
      }
    }

    return {
      answers: answers as any,
      provenance: {
        provider: "mock",
        model,
        inputHash,
        decisionSchemaVersion: schemaVersion,
        rubricHash,
        decisionIdentity,
        usage: {
          inputTokens: 150,
          outputTokens: 25,
        },
        latencyMs: this.options.latencyMs ?? 5,
        evaluatedAt: new Date().toISOString(),
      },
    };
  }
}
