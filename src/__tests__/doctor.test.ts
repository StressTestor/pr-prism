import { afterEach, describe, expect, it, vi } from "vitest";
import { checkEmbeddingReachability } from "../doctor.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("embedding doctor check", () => {
  it("performs a real cloud probe, validates it, and reports actual dimensions without vector content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [{ index: 0, embedding: [0.12345, 0.98765] }] }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const check = await checkEmbeddingReachability({
      provider: "openai",
      apiKey: "doctor-key",
      model: "custom",
      baseUrl: "https://compatible.example/v1",
      dimensions: 2,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(check).toEqual({ name: "embedding", status: "pass", detail: "openai (custom, 2 dims)" });
    expect(JSON.stringify(check)).not.toContain("0.12345");
    expect(JSON.stringify(check)).not.toContain("0.98765");
  });

  it("returns a failed check when the provider probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    const check = await checkEmbeddingReachability({
      provider: "openai",
      apiKey: "doctor-key",
      model: "custom",
      dimensions: 2,
    });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("network unavailable");
  });

  it("includes a sanitized ProviderError remedy for authentication failures", async () => {
    const secret = "doctor-secret-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(`unauthorized ${secret}`),
      }),
    );

    const check = await checkEmbeddingReachability({
      provider: "openai",
      apiKey: secret,
      model: "custom",
      dimensions: 2,
    });

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("Invalid API key");
    expect(check.detail).toContain("Check EMBEDDING_API_KEY in your .env");
    expect(check.detail).not.toContain(secret);
  });

  it("does not probe Ollama twice after initialization", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ embeddings: [[1, 2, 3]] }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);
    const check = await checkEmbeddingReachability({ provider: "ollama", model: "nomic-embed-text" });
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("3 dims");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails the single Ollama probe when the returned vector is invalid", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ embeddings: [[1, Number.NaN]] }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);
    const check = await checkEmbeddingReachability({ provider: "ollama", model: "nomic-embed-text" });
    expect(check.status).toBe("fail");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
