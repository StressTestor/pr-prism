import { classifyFetchError, classifyHttpError, ProviderError } from "./errors.js";
import { endpointFingerprint, normalizeHttpBaseUrl } from "./provider-url.js";
import type { EmbeddingProvider } from "./types.js";

export interface ProviderConfig {
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  dimensions?: number;
}

const OPENAI_MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

function validateConfiguredDimensions(config: ProviderConfig): void {
  const dimensions = config.dimensions;
  if (dimensions === undefined) return;

  if (!Number.isFinite(dimensions) || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new ProviderError(
      "Embeddings",
      "EMBEDDING_DIMENSIONS must be a positive integer",
      "Set EMBEDDING_DIMENSIONS to a finite whole number greater than zero",
    );
  }

  if (config.provider === "openai") {
    const nativeDimensions = OPENAI_MODEL_DIMENSIONS[config.model];
    if (nativeDimensions !== undefined && dimensions > nativeDimensions) {
      throw new ProviderError(
        "OpenAI Embeddings",
        `EMBEDDING_DIMENSIONS (${dimensions}) exceeds ${config.model}'s native maximum (${nativeDimensions})`,
        `Use a value <= ${nativeDimensions} or remove EMBEDDING_DIMENSIONS`,
      );
    }
    if (
      nativeDimensions !== undefined &&
      config.model === "text-embedding-ada-002" &&
      dimensions !== nativeDimensions
    ) {
      throw new ProviderError(
        "OpenAI Embeddings",
        `EMBEDDING_DIMENSIONS (${dimensions}) does not match ${config.model}'s fixed dimensions (${nativeDimensions})`,
        `Use ${nativeDimensions} or remove EMBEDDING_DIMENSIONS`,
      );
    }
  }
}

function invalidEmbeddingResponse(reason: string): ProviderError {
  return new ProviderError(
    "OpenAI Embeddings",
    `Invalid embedding response: ${reason}`,
    "Check that the API base URL, model, and EMBEDDING_DIMENSIONS are correct",
  );
}

function validateVector(vector: unknown, expectedDimensions: number, position: number): number[] {
  if (!Array.isArray(vector)) throw invalidEmbeddingResponse(`entry ${position} is missing an embedding array`);
  if (vector.length !== expectedDimensions) {
    throw invalidEmbeddingResponse(`entry ${position} has ${vector.length} dimensions; expected ${expectedDimensions}`);
  }
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw invalidEmbeddingResponse(`entry ${position} contains a non-finite numeric value`);
  }
  return vector;
}

class OpenAIEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private requestedDimensions?: number;
  dimensions: number;

  constructor(config: ProviderConfig, options?: { defaultDimensions?: number; sendDimensions?: boolean }) {
    if (!config.apiKey) throw new Error("EMBEDDING_API_KEY required for OpenAI");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = normalizeHttpBaseUrl(config.baseUrl || "https://api.openai.com/v1");
    const dimensions = config.dimensions ?? OPENAI_MODEL_DIMENSIONS[config.model] ?? options?.defaultDimensions;
    if (!dimensions) {
      throw new ProviderError(
        "OpenAI Embeddings",
        `Unknown embedding dimensions for model ${config.model}; Set EMBEDDING_DIMENSIONS`,
        "Set EMBEDDING_DIMENSIONS to the model's output dimensions",
      );
    }
    this.dimensions = dimensions;
    if (config.dimensions !== undefined && options?.sendDimensions !== false) {
      this.requestedDimensions = config.dimensions;
    }
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const sanitized = texts.map((t) => {
      if (!t || typeof t !== "string") return " ";
      return t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim() || " ";
    });
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: sanitized,
          model: this.model,
          ...(this.requestedDimensions === undefined ? {} : { dimensions: this.requestedDimensions }),
        }),
      });
    } catch (err: any) {
      throw classifyFetchError("OpenAI Embeddings", err, {
        apiKeyEnvVar: "EMBEDDING_API_KEY",
        secrets: [this.apiKey],
      });
    }
    if (!resp.ok) {
      const body = await resp.text();
      throw classifyHttpError("OpenAI Embeddings", resp.status, body, {
        apiKeyEnvVar: "EMBEDDING_API_KEY",
        secrets: [this.apiKey],
      });
    }
    let responseBody: any;
    try {
      responseBody = await resp.json();
    } catch {
      throw invalidEmbeddingResponse("body is not valid JSON");
    }
    if (!Array.isArray(responseBody?.data)) {
      throw invalidEmbeddingResponse("missing data array");
    }
    if (responseBody.data.length !== texts.length) {
      throw invalidEmbeddingResponse(`returned ${responseBody.data.length} vectors for ${texts.length} inputs`);
    }

    const hasIndices = responseBody.data.some((entry: any) => entry?.index !== undefined);
    const ordered = new Array<any>(texts.length);
    if (hasIndices) {
      for (const entry of responseBody.data) {
        if (!Number.isInteger(entry?.index) || entry.index < 0 || entry.index >= texts.length || ordered[entry.index]) {
          throw invalidEmbeddingResponse("response indices are missing, duplicated, or out of range");
        }
        ordered[entry.index] = entry;
      }
    } else {
      ordered.splice(0, ordered.length, ...responseBody.data);
    }
    return ordered.map((entry, index) => validateVector(entry?.embedding, this.dimensions, index));
  }
}

class KimiEmbeddings implements EmbeddingProvider {
  private inner: OpenAIEmbeddings;
  dimensions = 1024;

  constructor(config: ProviderConfig) {
    this.inner = new OpenAIEmbeddings(
      {
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: "https://api.moonshot.cn/v1",
      },
      { defaultDimensions: 1024, sendDimensions: false },
    );
  }

  embed(text: string) {
    return this.inner.embed(text);
  }
  embedBatch(texts: string[]) {
    return this.inner.embedBatch(texts);
  }
}

class OllamaEmbeddings implements EmbeddingProvider {
  private model: string;
  private baseUrl: string;
  dimensions = 0; // set by init()
  private initialized = false;

  constructor(config: ProviderConfig) {
    this.model = config.model || "nomic-embed-text";
    this.baseUrl = normalizeHttpBaseUrl(config.baseUrl || "http://localhost:11434");
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const probe = await this.embed("dimension probe");
    this.dimensions = probe.length;
    this.initialized = true;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (err: any) {
      throw classifyFetchError("Ollama", err);
    }
    if (!resp.ok) {
      const body = await resp.text();
      throw classifyHttpError("Ollama", resp.status, body);
    }
    const data = (await resp.json()) as any;
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new ProviderError(
        "Ollama",
        "Unexpected response format (missing embeddings array)",
        "Check that Ollama is up to date and the model supports embeddings",
      );
    }
    if (data.embeddings.length !== texts.length) {
      throw new ProviderError(
        "Ollama",
        `Invalid embedding response: returned ${data.embeddings.length} vectors for ${texts.length} inputs`,
        "Check that Ollama is up to date and the model supports embeddings",
      );
    }
    const expectedDimensions = this.dimensions || data.embeddings[0]?.length;
    if (!Number.isInteger(expectedDimensions) || expectedDimensions <= 0) {
      throw new ProviderError(
        "Ollama",
        "Invalid embedding response: vector dimensions are missing",
        "Check that Ollama is up to date and the model supports embeddings",
      );
    }
    if (
      !data.embeddings.every(
        (vector: unknown) =>
          Array.isArray(vector) &&
          vector.length === expectedDimensions &&
          vector.every((value) => typeof value === "number" && Number.isFinite(value)),
      )
    ) {
      throw new ProviderError(
        "Ollama",
        "Invalid embedding response: vectors contain invalid values or dimensions",
        "Check that Ollama is up to date and the model supports embeddings",
      );
    }
    if (!this.initialized) {
      this.dimensions = expectedDimensions;
      this.initialized = true;
    }
    return data.embeddings;
  }
}

class VoyageEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  dimensions = 1024;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) throw new Error("EMBEDDING_API_KEY required for VoyageAI");
    this.apiKey = config.apiKey;
    this.model = config.model || "voyage-2";
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    let resp: Response;
    try {
      resp = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model: this.model }),
      });
    } catch (err: any) {
      throw classifyFetchError("VoyageAI", err, { apiKeyEnvVar: "EMBEDDING_API_KEY" });
    }
    if (!resp.ok) {
      const body = await resp.text();
      throw classifyHttpError("VoyageAI", resp.status, body, { apiKeyEnvVar: "EMBEDDING_API_KEY" });
    }
    const data = (await resp.json()) as any;
    if (!data.data || !Array.isArray(data.data)) {
      throw new ProviderError(
        "VoyageAI",
        "Unexpected response format (missing data array)",
        "Check the API key and model name are correct",
      );
    }
    if (this.dimensions === 0 || this.dimensions === 1024) {
      this.dimensions = data.data[0].embedding.length;
    }
    return data.data.map((d: any) => d.embedding);
  }
}

class JinaEmbeddings implements EmbeddingProvider {
  private inner: OpenAIEmbeddings;
  dimensions = 1024;

  constructor(config: ProviderConfig) {
    this.inner = new OpenAIEmbeddings(
      {
        provider: config.provider,
        apiKey: config.apiKey,
        baseUrl: "https://api.jina.ai/v1",
        model: config.model || "jina-embeddings-v3",
      },
      { defaultDimensions: 1024, sendDimensions: false },
    );
  }

  embed(text: string) {
    return this.inner.embed(text);
  }
  embedBatch(texts: string[]) {
    return this.inner.embedBatch(texts);
  }
}

function withLocalDimensions(provider: EmbeddingProvider, dimensions?: number): EmbeddingProvider {
  if (dimensions === undefined || dimensions === provider.dimensions) return provider;
  if (dimensions > provider.dimensions) {
    throw new Error(
      `EMBEDDING_DIMENSIONS (${dimensions}) exceeds model's native dimensions (${provider.dimensions}). ` +
        `use a value <= ${provider.dimensions} or remove EMBEDDING_DIMENSIONS.`,
    );
  }
  return {
    dimensions,
    embed: async (text) => (await provider.embed(text)).slice(0, dimensions),
    embedBatch: async (texts) => (await provider.embedBatch(texts)).map((vector) => vector.slice(0, dimensions)),
  };
}

export async function createEmbeddingProvider(config: ProviderConfig): Promise<EmbeddingProvider> {
  validateConfiguredDimensions(config);
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddings(config);
    case "kimi":
      return withLocalDimensions(new KimiEmbeddings(config), config.dimensions);
    case "ollama": {
      const provider = new OllamaEmbeddings(config);
      await provider.init();
      return withLocalDimensions(provider, config.dimensions);
    }
    case "voyageai":
      return withLocalDimensions(new VoyageEmbeddings(config), config.dimensions);
    case "jina":
      return withLocalDimensions(new JinaEmbeddings(config), config.dimensions);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}

// Bump whenever prepareEmbeddingText's output format changes. It's folded into
// the embedding config hash so a format change invalidates cached embeddings and
// the scan warns to re-embed, instead of silently mixing old and new text vectors.
// v1: "Pull Request:"/"Issue:" type prefix. v2: no prefix.
export const EMBEDDING_TEXT_VERSION = 2;

export function embeddingConfigHash(provider: string, model: string, dimensions: number, baseUrl?: string): string {
  const legacyHash = `${provider}:${model}:${dimensions}:t${EMBEDDING_TEXT_VERSION}`;
  return baseUrl ? `${legacyHash}:e${endpointFingerprint(baseUrl)}` : legacyHash;
}

export function prepareEmbeddingText(item: { title: string; body: string; type: string }): string {
  // No type prefix. A leading "Pull Request:" / "Issue:" token systematically
  // pushes an issue away from its own fix PR in embedding space, which fragments
  // a single bug across separate clusters. Only takes effect after a re-embed.
  const title = (item.title || "Untitled").trim();
  const body = (item.body || "").trim().slice(0, 2000);
  return body ? `${title}\n\n${body}` : title;
}
