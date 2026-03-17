import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
    await expect(
      reviewPR("Fix bug", "Description", "diff", DEFAULT_CONFIG),
    ).rejects.toThrow(ProviderError);
  });

  it("handles API error with ProviderError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { message: "Unauthorized" } }),
      text: () => Promise.resolve("Unauthorized"),
    });

    const { reviewPR } = await import("../reviewer.js");
    await expect(
      reviewPR("Fix bug", "Description", "diff", DEFAULT_CONFIG),
    ).rejects.toThrow(/Invalid API key/);
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
    await expect(
      reviewPR("Fix bug", "Description", "diff", DEFAULT_CONFIG),
    ).rejects.toThrow();
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
});
