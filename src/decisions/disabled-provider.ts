import { ProviderError } from "../errors.js";
import type {
  DecisionProvider,
  DecisionQuestions,
  DecisionRequest,
  DecisionRequestOptions,
  DecisionResult,
} from "./types.js";

/**
 * Disabled decision provider representing an inactive typed decision layer.
 *
 * Enforces the disabled-provider contract:
 * - Presence of TYPESAFE_API_KEY does NOT activate Jev.
 * - Calling evaluate on a disabled provider throws a clear ProviderError.
 * - Zero network requests or inference calls are made.
 */
export class DisabledDecisionProvider implements DecisionProvider {
  readonly id = "disabled";
  readonly defaultModel = "disabled";

  async evaluate<Q extends DecisionQuestions>(
    _request: DecisionRequest<Q>,
    _options?: DecisionRequestOptions,
  ): Promise<DecisionResult<Q>> {
    throw new ProviderError(
      "Disabled",
      "Decision provider is disabled",
      "Enable decisions by setting decisions.enabled: true in prism.config.yaml or DECISION_ENABLED=true in your environment.",
    );
  }
}
