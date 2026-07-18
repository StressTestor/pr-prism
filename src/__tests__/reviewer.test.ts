import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../errors.js";

// We need to test reviewPR which internally creates an LLM and calls fetch.
// Mock global fetch to control responses.

const VALID_REVIEW = {
  summary: "Adds input validation to the user form",
  concerns: ["No tests for edge cases"],
  recommendation: "merge" as const,
  confidence: 0.85,
};

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const DEFAULT_CONFIG = {
  provider: "openai",
  apiKey: "sk-test-key",
  model: "gpt-4o-mini",
};

describe("reviewPR", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses valid JSON response", async () => {
    globalThis.fetch = mockFetchResponse({
      choices: [{ message: { content: JSON.stringify(VALID_REVIEW) } }],
    });

    const { reviewPR } = await import("../reviewer.js");
    const result = await reviewPR("Fix form validation", "Adds checks", "diff content", DEFAULT_CONFIG);

    expect(result.summary).toBe(VALID_REVIEW.summary);
    expect(result.concerns).toEqual(VALID_REVIEW.concerns);
    expect(result.recommendation).toBe("merge");
    expect(result.confidence).toBe(0.85);
  });

  it("handles empty choices array", async () => {
    globalThis.fetch = mockFetchResponse({
      choices: [],
    });

    const { reviewPR } = await import("../reviewer.js");
    await expect(reviewPR("Fix bug", "Description", "diff", DEFAULT_CONFIG)).rejects.toThrow(ProviderError);
  });

  it("handles API error with ProviderError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { message: "Unauthorized" } }),
      text: () => Promise.resolve("Unauthorized"),
    });

    const { reviewPR } = await import("../reviewer.js");
    await expect(reviewPR("Fix bug", "Description", "diff", DEFAULT_CONFIG)).rejects.toThrow(/Invalid API key/);
  });

  it("validates response against zod schema", async () => {
    // Invalid recommendation value and confidence > 1
    const invalidReview = {
      summary: "Test",
      concerns: [],
      recommendation: "yolo",
      confidence: 5.0,
    };

    // First call (completeJSON) returns invalid data, second call (complete fallback) also returns invalid
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify(invalidReview) } }],
        }),
      text: () => Promise.resolve(""),
    });

    const { reviewPR } = await import("../reviewer.js");
    await expect(reviewPR("Fix bug", "Description", "diff", DEFAULT_CONFIG)).rejects.toThrow();
  });

  it("truncates diff longer than 50KB", async () => {
    const longDiff = "a".repeat(60_000);
    let capturedBody = "";

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      capturedBody = init.body;
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify(VALID_REVIEW) } }],
          }),
        text: () => Promise.resolve(""),
      };
    });

    const { reviewPR } = await import("../reviewer.js");
    await reviewPR("Big PR", "Lots of changes", longDiff, DEFAULT_CONFIG);

    expect(capturedBody).toContain("[DIFF TRUNCATED]");
    // The diff in the prompt should be capped, not the full 60k
    expect(capturedBody.length).toBeLessThan(60_000);
  });

  it("uses a normalized generic OpenAI-compatible endpoint and the separate LLM API key", async () => {
    let capturedUrl = "";
    let capturedAuthorization = "";
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      capturedUrl = url;
      capturedAuthorization = init.headers.Authorization;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(VALID_REVIEW) } }] }),
        text: () => Promise.resolve(""),
      };
    });

    const { reviewPR } = await import("../reviewer.js");
    await reviewPR("Synthetic", "Description", "diff", {
      provider: "openai",
      apiKey: "llm-only-key",
      model: "provider/model",
      baseUrl: "https://compatible.example/v1///",
    });

    expect(capturedUrl).toBe("https://compatible.example/v1/chat/completions");
    expect(capturedAuthorization).toBe("Bearer llm-only-key");
  });

  it("uses the default OpenAI chat completions endpoint", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(VALID_REVIEW) } }] }),
        text: () => Promise.resolve(""),
      };
    });
    const { reviewPR } = await import("../reviewer.js");
    await reviewPR("Synthetic", "Description", "diff", DEFAULT_CONFIG);
    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it.each([
    ["kimi", "https://api.moonshot.cn/v1/chat/completions", "Bearer provider-key"],
    ["opencode", "https://opencode.ai/zen/v1/chat/completions", "Bearer provider-key"],
    ["ollama", "http://localhost:11434/v1/chat/completions", "Bearer ollama"],
  ])("keeps the %s endpoint unchanged", async (provider, expectedUrl, expectedAuthorization) => {
    let capturedUrl = "";
    let capturedAuthorization = "";
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      capturedUrl = url;
      capturedAuthorization = init.headers.Authorization;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(VALID_REVIEW) } }] }),
        text: () => Promise.resolve(""),
      };
    });
    const { reviewPR } = await import("../reviewer.js");
    await reviewPR("Synthetic", "Description", "diff", {
      provider,
      apiKey: "provider-key",
      model: "provider-model",
      baseUrl: "https://ignored.example/v1",
    });
    expect(capturedUrl).toBe(expectedUrl);
    expect(capturedAuthorization).toBe(expectedAuthorization);
  });

  it("keeps Anthropic request behavior unchanged", async () => {
    let capturedUrl = "";
    let capturedKey = "";
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      capturedUrl = url;
      capturedKey = init.headers["x-api-key"];
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: [{ text: JSON.stringify(VALID_REVIEW) }] }),
        text: () => Promise.resolve(""),
      };
    });
    const { reviewPR } = await import("../reviewer.js");
    await reviewPR("Synthetic", "Description", "diff", {
      provider: "anthropic",
      apiKey: "anthropic-key",
      model: "claude-test",
      baseUrl: "https://ignored.example/v1",
    });
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedKey).toBe("anthropic-key");
  });

  it("classifies generic OpenAI connection failures as ProviderError", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }));
    const { reviewPR } = await import("../reviewer.js");
    await expect(reviewPR("Synthetic", "Description", "diff", DEFAULT_CONFIG)).rejects.toBeInstanceOf(ProviderError);
  });
});
