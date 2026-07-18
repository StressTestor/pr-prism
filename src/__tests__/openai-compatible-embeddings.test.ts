import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider } from "../embeddings.js";
import { ProviderError } from "../errors.js";

function mockResponse(body: unknown, status = 200, text = JSON.stringify(body)) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generic OpenAI-compatible embeddings", () => {
  it.each([
    ["negative", -1],
    ["zero", 0],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s dimensions in the public factory before fetch", async (_label, dimensions) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createEmbeddingProvider({
        provider: "openai",
        apiKey: "key",
        model: "provider/custom-model",
        dimensions,
      }),
    ).rejects.toThrow(/EMBEDDING_DIMENSIONS must be a positive integer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects dimensions above a known OpenAI model's native maximum before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createEmbeddingProvider({
        provider: "openai",
        apiKey: "key",
        model: "text-embedding-3-small",
        dimensions: 2048,
      }),
    ).rejects.toThrow(/native maximum \(1536\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects dimensions below text-embedding-ada-002's fixed native size before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createEmbeddingProvider({
        provider: "openai",
        apiKey: "key",
        model: "text-embedding-ada-002",
        dimensions: 512,
      }),
    ).rejects.toThrow(/fixed dimensions \(1536\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts explicit ada-002 native dimensions without sending a dimensions request field", async () => {
    const fetchMock = mockResponse({ data: [{ index: 0, embedding: new Array(1536).fill(0.25) }] });
    vi.stubGlobal("fetch", fetchMock);
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "text-embedding-ada-002",
      dimensions: 1536,
    });

    const vector = await embedder.embed("probe");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body).toEqual({ input: ["probe"], model: "text-embedding-ada-002" });
    expect(body).not.toHaveProperty("dimensions");
    expect(vector).toHaveLength(1536);
  });

  it("accepts and sends a valid lower dimension for an OpenAI model that supports selection", async () => {
    const fetchMock = mockResponse({ data: [{ index: 0, embedding: new Array(512).fill(0.25) }] });
    vi.stubGlobal("fetch", fetchMock);
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "text-embedding-3-small",
      dimensions: 512,
    });

    const vector = await embedder.embed("probe");

    expect(embedder.dimensions).toBe(512);
    expect(vector).toHaveLength(512);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).dimensions).toBe(512);
  });

  it("rejects invalid local-provider dimensions before they can reach truncation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text", dimensions: -1 }),
    ).rejects.toThrow(/EMBEDDING_DIMENSIONS must be a positive integer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a normalized custom endpoint, bearer key, configured dimensions, sanitized input, and response indices", async () => {
    const fetchMock = mockResponse({
      data: [
        { index: 1, embedding: [3, 4] },
        { index: 0, embedding: [1, 2] },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "embedding-secret",
      model: "provider/custom-model",
      baseUrl: "https://compatible.example/v1///",
      dimensions: 2,
    });
    const vectors = await embedder.embedBatch([" first\u0000 ", "second"]);

    expect(embedder.dimensions).toBe(2);
    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://compatible.example/v1/embeddings");
    expect(init.headers.Authorization).toBe("Bearer embedding-secret");
    expect(JSON.parse(init.body)).toEqual({
      input: ["first", "second"],
      model: "provider/custom-model",
      dimensions: 2,
    });
  });

  it("uses the default OpenAI endpoint without a dimensions field when the model is known", async () => {
    const fetchMock = mockResponse({ data: [{ index: 0, embedding: new Array(1536).fill(0) }] });
    vi.stubGlobal("fetch", fetchMock);
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "openai-key",
      model: "text-embedding-3-small",
    });

    await embedder.embed("probe");

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      input: ["probe"],
      model: "text-embedding-3-small",
    });
  });

  it.each([
    ["text-embedding-3-small", 1536],
    ["text-embedding-3-large", 3072],
    ["text-embedding-ada-002", 1536],
  ])("uses the known dimensions for %s", async (model, dimensions) => {
    const embedder = await createEmbeddingProvider({ provider: "openai", apiKey: "key", model });
    expect(embedder.dimensions).toBe(dimensions);
  });

  it("requires explicit dimensions for an unknown compatible model", async () => {
    await expect(
      createEmbeddingProvider({ provider: "openai", apiKey: "key", model: "provider/unknown" }),
    ).rejects.toThrow(/Set EMBEDDING_DIMENSIONS/);
  });

  it("rejects an output-count mismatch with a ProviderError", async () => {
    vi.stubGlobal("fetch", mockResponse({ data: [{ embedding: [1, 2] }] }));
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "custom",
      dimensions: 2,
    });
    await expect(embedder.embedBatch(["one", "two"])).rejects.toBeInstanceOf(ProviderError);
    await expect(embedder.embedBatch(["one", "two"])).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });

  it("rejects duplicate response indices even when the output count matches", async () => {
    vi.stubGlobal(
      "fetch",
      mockResponse({
        data: [
          { index: 0, embedding: [1, 2] },
          { index: 0, embedding: [3, 4] },
        ],
      }),
    );
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "custom",
      dimensions: 2,
    });

    const error = await embedder.embedBatch(["one", "two"]).catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(/indices are missing, duplicated, or out of range/);
  });

  it("rejects a mixed indexed and unindexed response", async () => {
    vi.stubGlobal(
      "fetch",
      mockResponse({
        data: [{ index: 0, embedding: [1, 2] }, { embedding: [3, 4] }],
      }),
    );
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "custom",
      dimensions: 2,
    });

    await expect(embedder.embedBatch(["one", "two"])).rejects.toThrow(
      /indices are missing, duplicated, or out of range/,
    );
  });

  it.each([
    ["negative", -1],
    ["out-of-range", 2],
    ["fractional", 0.5],
  ])("rejects a %s response index", async (_label, invalidIndex) => {
    vi.stubGlobal(
      "fetch",
      mockResponse({
        data: [
          { index: 0, embedding: [1, 2] },
          { index: invalidIndex, embedding: [3, 4] },
        ],
      }),
    );
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "custom",
      dimensions: 2,
    });

    await expect(embedder.embedBatch(["one", "two"])).rejects.toThrow(
      /indices are missing, duplicated, or out of range/,
    );
  });

  it("rejects a successful response without a data array", async () => {
    vi.stubGlobal("fetch", mockResponse({ data: "not-an-array" }));
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "custom",
      dimensions: 2,
    });
    await expect(embedder.embed("one")).rejects.toThrow(/missing data array/);
  });

  it("rejects dimension mismatches", async () => {
    vi.stubGlobal("fetch", mockResponse({ data: [{ embedding: [1] }] }));
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "custom",
      dimensions: 2,
    });
    await expect(embedder.embed("one")).rejects.toThrow(/has 1 dimensions; expected 2/);
  });

  it("rejects missing embedding arrays", async () => {
    vi.stubGlobal("fetch", mockResponse({ data: [{ index: 0 }] }));
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "custom",
      dimensions: 2,
    });
    await expect(embedder.embed("one")).rejects.toThrow(/missing an embedding array/);
  });

  it.each([
    ["a string", [1, "2"]],
    ["NaN", [1, Number.NaN]],
    ["positive infinity", [1, Number.POSITIVE_INFINITY]],
    ["negative infinity", [1, Number.NEGATIVE_INFINITY]],
  ])("rejects %s vector values", async (_label, embedding) => {
    vi.stubGlobal("fetch", mockResponse({ data: [{ embedding }] }));
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "key",
      model: "custom",
      dimensions: 2,
    });
    await expect(embedder.embed("one")).rejects.toThrow(/non-finite numeric value/);
  });

  it("never exposes the embedding API key from fetch or HTTP errors", async () => {
    const secret = "embedding-secret-value";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`request failed with ${secret}`)));
    const embedder = await createEmbeddingProvider({
      provider: "openai",
      apiKey: secret,
      model: "custom",
      dimensions: 2,
    });

    let message = "";
    try {
      await embedder.embed("one");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);

    vi.stubGlobal("fetch", mockResponse({}, 400, `bad request: ${secret}`));
    try {
      await embedder.embed("one");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);
  });
});
