import { createEmbeddingProvider, type ProviderConfig } from "./embeddings.js";

export interface DoctorCheck {
  name: "embedding";
  status: "pass" | "fail";
  detail: string;
}

const EMBEDDING_PROBE_TEXT = "prism doctor";

function sanitizedDetail(error: unknown, apiKey?: string): string {
  let value: string;
  if (error && typeof error === "object" && "reason" in error) {
    const reason = String((error as { reason: unknown }).reason);
    const remedy = "remedy" in error ? String((error as { remedy: unknown }).remedy) : "";
    value = remedy ? `${reason}. ${remedy}` : reason;
  } else {
    value = error instanceof Error ? error.message : String(error);
  }
  return apiKey ? value.split(apiKey).join("[REDACTED]") : value;
}

export async function checkEmbeddingReachability(config: ProviderConfig): Promise<DoctorCheck> {
  try {
    const embedder = await createEmbeddingProvider(config);
    let actualDimensions = embedder.dimensions;

    // Ollama initialization already performs an embedding request to discover dimensions.
    if (config.provider !== "ollama") {
      const vector = await embedder.embed(EMBEDDING_PROBE_TEXT);
      if (
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.length !== embedder.dimensions ||
        !vector.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        throw new Error("embedding probe returned an invalid vector");
      }
      actualDimensions = vector.length;
    } else if (!Number.isInteger(actualDimensions) || actualDimensions <= 0) {
      throw new Error("embedding probe returned invalid dimensions");
    }

    return {
      name: "embedding",
      status: "pass",
      detail: `${config.provider} (${config.model}, ${actualDimensions} dims)`,
    };
  } catch (error) {
    return {
      name: "embedding",
      status: "fail",
      detail: sanitizedDetail(error, config.apiKey),
    };
  }
}
