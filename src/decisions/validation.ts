import { ProviderError } from "../errors.js";
import type {
  ChoiceAnswer,
  ChoiceQuestionDef,
  DecisionAnswer,
  DecisionQuestionDef,
  DecisionQuestions,
  NoulAnswer,
  ScoreAnswer,
  ScoreQuestionDef,
} from "./types.js";

/**
 * Validates that a raw model answer satisfies all constraints for the given question definition:
 * - Answer primitive matches question type
 * - Choice is an explicit own-property member of permitted criteria (rejects toString, constructor, __proto__)
 * - Confidence is a finite number in [0, 1]
 * - Probability values are finite numbers in [0, 1]
 * - Probability distribution sums to approximately 1.0 (within 0.05 tolerance)
 * - Score is a finite number within rubric bounds [0, criteria.length - 1]
 * - Noul probability is a finite number strictly within [0, 1] (no silent clamping)
 * - Missing or malformed answers are rejected with ProviderError
 */
export function validateDecisionAnswer(
  name: string,
  qDef: DecisionQuestionDef,
  rawAns: unknown,
  providerName = "Jev",
): DecisionAnswer {
  if (rawAns === undefined || rawAns === null) {
    throw new ProviderError(
      providerName,
      `Missing answer for question "${name}"`,
      "Model did not return a result for this question.",
    );
  }

  if (typeof rawAns !== "object" || Array.isArray(rawAns)) {
    throw new ProviderError(
      providerName,
      `Malformed answer for "${name}": expected structured object, received ${typeof rawAns}`,
      `Provide a structured answer object for question "${name}".`,
    );
  }

  const ansObj = rawAns as Record<string, unknown>;

  if (ansObj.type !== qDef.type) {
    throw new ProviderError(
      providerName,
      `Mismatched answer type for "${name}": expected "${qDef.type}", received "${ansObj.type}"`,
      `The answer type must match the question definition type "${qDef.type}".`,
    );
  }

  switch (qDef.type) {
    case "choice": {
      return validateChoiceAnswer(name, qDef as ChoiceQuestionDef, ansObj, providerName);
    }
    case "score": {
      return validateScoreAnswer(name, qDef as ScoreQuestionDef, ansObj, providerName);
    }
    case "noul": {
      return validateNoulAnswer(name, ansObj, providerName);
    }
  }
}

function validateConfidence(name: string, confidence: unknown, providerName: string): number {
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ProviderError(
      providerName,
      `Malformed confidence for "${name}": Confidence must be a finite number within [0, 1]. Received: ${String(confidence)}`,
      "Confidence values must be calibrated probabilities between 0 and 1 inclusive.",
    );
  }
  return confidence;
}

function validateProbabilities(
  name: string,
  rawProbs: unknown,
  allowedKeys: Set<string>,
  providerName: string,
): Record<string, number> {
  if (rawProbs === undefined || rawProbs === null) {
    return {};
  }

  if (typeof rawProbs !== "object" || Array.isArray(rawProbs)) {
    throw new ProviderError(
      providerName,
      `Malformed probabilities for "${name}": expected key-value mapping`,
      "Expected probabilities to be a key-value mapping of outcome to probability.",
    );
  }

  const probs = rawProbs as Record<string, unknown>;
  const validated: Record<string, number> = {};
  const entries = Object.entries(probs);

  if (entries.length === 0) {
    return {};
  }

  let sum = 0;
  for (const [k, v] of entries) {
    if (!allowedKeys.has(k)) {
      throw new ProviderError(
        providerName,
        `Invalid probability key "${k}" for "${name}": not in criteria [${Array.from(allowedKeys).join(", ")}]`,
        `Outcome key must be one of permitted criteria: [${Array.from(allowedKeys).join(", ")}]`,
      );
    }

    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new ProviderError(
        providerName,
        `Invalid probability value for key "${k}" in "${name}": Probability must be a finite number within [0, 1]. Received: ${String(v)}`,
        "All probability values must be finite numbers between 0 and 1 inclusive.",
      );
    }

    validated[k] = v;
    sum += v;
  }

  // Distribution validation: if non-empty, sum must be ~1.0 within numerical tolerance
  if (entries.length > 1 && (sum < 0.95 || sum > 1.05)) {
    throw new ProviderError(
      providerName,
      `Invalid probability distribution for "${name}": Sum of probabilities must equal 1.0 (received ${sum.toFixed(4)})`,
      "The sum of discrete outcome probabilities must equal 1.0 within numerical tolerance.",
    );
  }

  return validated;
}

function validateChoiceAnswer(
  name: string,
  qDef: ChoiceQuestionDef,
  ansObj: Record<string, unknown>,
  providerName: string,
): ChoiceAnswer {
  if (typeof ansObj.choice !== "string") {
    throw new ProviderError(
      providerName,
      `Malformed choice answer for "${name}": Expected choice to be a string`,
      "Choice must be a string identifier matching one of the permitted criteria.",
    );
  }

  const permittedKeys = Object.keys(qDef.criteria);
  // Own-property check strictly rejects prototype-chain properties like toString, constructor, __proto__
  if (!Object.hasOwn(qDef.criteria, ansObj.choice)) {
    throw new ProviderError(
      providerName,
      `Invalid choice "${ansObj.choice}" for question "${name}": must be one of [${permittedKeys.join(", ")}]`,
      `Select a choice from the permitted criteria: [${permittedKeys.join(", ")}].`,
    );
  }

  const confidence = validateConfidence(name, ansObj.confidence, providerName);
  const probabilities = validateProbabilities(name, ansObj.probabilities, new Set(permittedKeys), providerName);

  return {
    type: "choice",
    choice: ansObj.choice,
    confidence,
    probabilities,
  };
}

function validateScoreAnswer(
  name: string,
  qDef: ScoreQuestionDef,
  ansObj: Record<string, unknown>,
  providerName: string,
): ScoreAnswer {
  const maxScore = qDef.criteria.length - 1;

  if (
    typeof ansObj.score !== "number" ||
    !Number.isFinite(ansObj.score) ||
    ansObj.score < 0 ||
    ansObj.score > maxScore
  ) {
    throw new ProviderError(
      providerName,
      `Malformed score answer for "${name}": Score must be a finite number within rubric bounds [0, ${maxScore}]. Received: ${String(ansObj.score)}`,
      `Score must fall between 0 and ${maxScore} according to the question criteria.`,
    );
  }

  const confidence = validateConfidence(name, ansObj.confidence, providerName);
  const allowedKeys = new Set(Array.from({ length: qDef.criteria.length }, (_, i) => String(i)));
  const probabilities = validateProbabilities(name, ansObj.probabilities, allowedKeys, providerName);

  let legend: Record<string, string> | undefined;
  if (ansObj.legend && typeof ansObj.legend === "object" && !Array.isArray(ansObj.legend)) {
    legend = ansObj.legend as Record<string, string>;
  }

  return {
    type: "score",
    score: ansObj.score,
    confidence,
    probabilities,
    legend,
  };
}

function validateNoulAnswer(name: string, ansObj: Record<string, unknown>, providerName: string): NoulAnswer {
  if (typeof ansObj.noul !== "number" || !Number.isFinite(ansObj.noul) || ansObj.noul < 0 || ansObj.noul > 1) {
    throw new ProviderError(
      providerName,
      `Malformed noul answer for "${name}": Expected finite probability strictly within [0, 1]. Received: ${String(ansObj.noul)}`,
      "Noul calibrated probabilities must be strictly within [0, 1] without clamping.",
    );
  }

  return {
    type: "noul",
    noul: ansObj.noul,
  };
}

/**
 * Validates a map of answers against expected question definitions.
 */
export function validateDecisionAnswers<Q extends DecisionQuestions>(
  questions: Q,
  rawAnswers: unknown,
  providerName = "Jev",
): { [K in keyof Q]: DecisionAnswer } {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new ProviderError(
      providerName,
      "Invalid response from model (missing answers payload)",
      "The model response did not contain an answers object.",
    );
  }

  const answersMap = rawAnswers as Record<string, unknown>;
  const validated: Record<string, DecisionAnswer> = {};

  for (const [name, qDef] of Object.entries(questions)) {
    const rawAns = Object.hasOwn(answersMap, name) ? answersMap[name] : undefined;
    validated[name] = validateDecisionAnswer(name, qDef, rawAns, providerName);
  }

  return validated as { [K in keyof Q]: DecisionAnswer };
}
