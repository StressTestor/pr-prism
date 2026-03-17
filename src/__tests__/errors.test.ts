import { describe, expect, it } from "vitest";
import { classifyFetchError, classifyHttpError, ProviderError } from "../errors.js";

describe("ProviderError", () => {
  it("formats message with provider and reason", () => {
    const err = new ProviderError("OpenAI", "Invalid API key", "Check your .env");
    expect(err.message).toBe("OpenAI: Invalid API key");
    expect(err.name).toBe("ProviderError");
    expect(err.provider).toBe("OpenAI");
    expect(err.reason).toBe("Invalid API key");
    expect(err.remedy).toBe("Check your .env");
  });

  it("stores optional statusCode", () => {
    const err = new ProviderError("Ollama", "Not found", "Pull the model", 404);
    expect(err.statusCode).toBe(404);
  });

  it("format() includes provider, reason, and remedy", () => {
    const err = new ProviderError("VoyageAI", "Rate limited", "Wait and retry");
    const formatted = err.format();
    expect(formatted).toContain("VoyageAI");
    expect(formatted).toContain("Rate limited");
    expect(formatted).toContain("Wait and retry");
  });
});

describe("classifyFetchError", () => {
  it("returns Ollama-specific remedy for ECONNREFUSED", () => {
    const err = { code: "ECONNREFUSED", message: "Connection refused" };
    const result = classifyFetchError("Ollama", err);
    expect(result).toBeInstanceOf(ProviderError);
    expect(result.provider).toBe("Ollama");
    expect(result.remedy).toContain("ollama serve");
  });

  it("returns generic ECONNREFUSED for non-Ollama providers", () => {
    const err = { code: "ECONNREFUSED", message: "Connection refused" };
    const result = classifyFetchError("OpenAI", err);
    expect(result.remedy).not.toContain("ollama serve");
    expect(result.reason).toContain("Connection refused");
  });

  it("classifies ENOTFOUND as network error", () => {
    const err = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" };
    const result = classifyFetchError("OpenAI", err);
    expect(result.reason).toContain("Cannot reach");
    expect(result.remedy).toContain("internet");
  });

  it("classifies ETIMEDOUT as timeout", () => {
    const err = { code: "ETIMEDOUT", message: "connect ETIMEDOUT" };
    const result = classifyFetchError("VoyageAI", err);
    expect(result.reason).toContain("timed out");
  });

  it("passes through existing ProviderError unchanged", () => {
    const original = new ProviderError("Custom", "Custom reason", "Custom remedy");
    const result = classifyFetchError("Ignored", original);
    expect(result).toBe(original);
  });

  it("falls back to generic error for unknown codes", () => {
    const err = new Error("Something weird happened");
    const result = classifyFetchError("OpenAI", err);
    expect(result).toBeInstanceOf(ProviderError);
    expect(result.reason).toContain("Something weird happened");
  });
});

describe("classifyHttpError", () => {
  it("classifies 401 as invalid API key", () => {
    const result = classifyHttpError("OpenAI", 401, "Unauthorized");
    expect(result.reason).toContain("Invalid API key");
  });

  it("uses custom apiKeyEnvVar in 401 remedy", () => {
    const result = classifyHttpError("OpenAI", 401, "Unauthorized", {
      apiKeyEnvVar: "EMBEDDING_API_KEY",
    });
    expect(result.remedy).toContain("EMBEDDING_API_KEY");
  });

  it("classifies 404 for Ollama as model not found with pull suggestion", () => {
    const result = classifyHttpError("Ollama", 404, "model 'nomic-embed' not found");
    expect(result.reason).toContain("Model not found");
    expect(result.reason).toContain("nomic-embed");
    expect(result.remedy).toContain("ollama pull");
  });

  it("classifies 404 generically for non-Ollama", () => {
    const result = classifyHttpError("OpenAI", 404, "Not found");
    expect(result.reason).toContain("Not found (404)");
  });

  it("classifies 429 as rate limited", () => {
    const result = classifyHttpError("VoyageAI", 429, "Too many requests");
    expect(result.reason).toContain("Rate limited");
  });

  it("classifies 500/502/503 as server errors", () => {
    for (const status of [500, 502, 503]) {
      const result = classifyHttpError("OpenAI", status, "Internal Server Error");
      expect(result.reason).toContain("Server error");
      expect(result.reason).toContain(String(status));
    }
  });

  it("falls back to generic message for unknown status codes", () => {
    const result = classifyHttpError("OpenAI", 418, "I'm a teapot");
    expect(result.reason).toContain("418");
  });
});
