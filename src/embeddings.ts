import type { EmbeddingProvider } from "./types.js";

interface ProviderConfig {
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

class OpenAIEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  dimensions = 1536;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) throw new Error("EMBEDDING_API_KEY required for OpenAI");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    if (config.model.includes("3-large")) this.dimensions = 3072;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const sanitized = texts.map(t => {
      if (!t || typeof t !== "string") return " ";
      return t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim() || " ";
    });
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: sanitized, model: this.model }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Embedding API error (${resp.status}): ${err}`);
    }
    const data = await resp.json() as any;
    return data.data.map((d: any) => d.embedding);
  }
}

class KimiEmbeddings implements EmbeddingProvider {
  private inner: OpenAIEmbeddings;
  dimensions = 1024;

  constructor(config: ProviderConfig) {
    this.inner = new OpenAIEmbeddings({
      ...config,
      baseUrl: "https://api.moonshot.cn/v1",
    });
  }

  embed(text: string) { return this.inner.embed(text); }
  embedBatch(texts: string[]) { return this.inner.embedBatch(texts); }
}

class OllamaEmbeddings implements EmbeddingProvider {
  private model: string;
  private baseUrl: string;
  dimensions = 0; // set by init()
  private initialized = false;

  constructor(config: ProviderConfig) {
    this.model = config.model || "qwen3-embedding:0.6b";
    this.baseUrl = config.baseUrl || "http://localhost:11434";
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
      if (err.code === "ECONNREFUSED") {
        throw new Error(`Ollama not running — start it with: ollama serve`);
      }
      throw err;
    }
    if (!resp.ok) throw new Error(`Ollama error (${resp.status}): ${await resp.text()}`);
    const data = await resp.json() as any;
    if (!this.initialized) {
      this.dimensions = data.embeddings[0].length;
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
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });
    if (!resp.ok) throw new Error(`VoyageAI error (${resp.status})`);
    const data = await resp.json() as any;
    this.dimensions = data.data[0].embedding.length;
    return data.data.map((d: any) => d.embedding);
  }
}

class JinaEmbeddings implements EmbeddingProvider {
  private inner: OpenAIEmbeddings;
  dimensions = 1024;

  constructor(config: ProviderConfig) {
    this.inner = new OpenAIEmbeddings({
      ...config,
      baseUrl: "https://api.jina.ai/v1",
      model: config.model || "jina-embeddings-v3",
    });
  }

  embed(text: string) { return this.inner.embed(text); }
  embedBatch(texts: string[]) { return this.inner.embedBatch(texts); }
}

export async function createEmbeddingProvider(config: ProviderConfig): Promise<EmbeddingProvider> {
  switch (config.provider) {
    case "openai": return new OpenAIEmbeddings(config);
    case "kimi": return new KimiEmbeddings(config);
    case "ollama": {
      const provider = new OllamaEmbeddings(config);
      await provider.init();
      return provider;
    }
    case "voyageai": return new VoyageEmbeddings(config);
    case "jina": return new JinaEmbeddings(config);
    default: throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}

export function prepareEmbeddingText(item: { title: string; body: string; type: string }): string {
  const prefix = item.type === "pr" ? "Pull Request" : "Issue";
  const title = (item.title || "Untitled").trim();
  const body = (item.body || "").trim().slice(0, 2000);
  return `${prefix}: ${title}${body ? `\n\n${body}` : ""}`;
}
