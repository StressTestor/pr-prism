import { describe, expect, it } from "vitest";
import { EMBEDDING_TEXT_VERSION, embeddingConfigHash, prepareEmbeddingText } from "../embeddings.js";

describe("prepareEmbeddingText", () => {
  it("formats title and body without a type prefix", () => {
    const result = prepareEmbeddingText({ title: "Fix bug", body: "This fixes the login issue", type: "pr" });
    expect(result).toBe("Fix bug\n\nThis fixes the login issue");
  });

  it("formats title without body", () => {
    const result = prepareEmbeddingText({ title: "Feature request", body: "", type: "issue" });
    expect(result).toBe("Feature request");
  });

  it("a PR and an issue with identical content embed to identical text (no type bias)", () => {
    const content = { title: "Login fails on empty password", body: "steps: submit the form blank" };
    const pr = prepareEmbeddingText({ ...content, type: "pr" });
    const issue = prepareEmbeddingText({ ...content, type: "issue" });
    // the old "Pull Request:" / "Issue:" prefix pulled these apart in embedding space
    expect(pr).toBe(issue);
  });

  it("truncates long bodies", () => {
    const longBody = "x".repeat(3000);
    const result = prepareEmbeddingText({ title: "Test", body: longBody, type: "pr" });
    expect(result.length).toBeLessThanOrEqual(2000 + "Test\n\n".length);
  });

  it("handles null-ish title", () => {
    const result = prepareEmbeddingText({ title: "", body: "body", type: "pr" });
    expect(result).toContain("Untitled");
  });
});

describe("embeddingConfigHash", () => {
  it("folds in the text-format version so an embed-text change invalidates cached embeddings", () => {
    // pre-guard DBs stored the bare provider:model:dims hash; a text change like
    // dropping the type prefix must now mismatch it so the scan warns to reset.
    const legacy = "ollama:nomic-embed-text:768";
    const now = embeddingConfigHash("ollama", "nomic-embed-text", 768);
    expect(now).not.toBe(legacy);
    expect(now).toContain(`:t${EMBEDDING_TEXT_VERSION}`);
  });

  it("stays stable for the same provider/model/dims/version", () => {
    expect(embeddingConfigHash("jina", "jina-v3", 1024)).toBe(embeddingConfigHash("jina", "jina-v3", 1024));
  });

  it("preserves the legacy hash format without a custom URL", () => {
    expect(embeddingConfigHash("openai", "text-embedding-3-small", 1536)).toBe(
      `openai:text-embedding-3-small:1536:t${EMBEDDING_TEXT_VERSION}`,
    );
  });

  it("normalizes trailing slashes in custom endpoint fingerprints", () => {
    expect(embeddingConfigHash("openai", "custom", 1024, "https://example.com/v1/")).toBe(
      embeddingConfigHash("openai", "custom", 1024, "https://example.com/v1///"),
    );
  });

  it("distinguishes endpoint origins and paths", () => {
    const first = embeddingConfigHash("openai", "custom", 1024, "https://one.example/v1");
    expect(first).not.toBe(embeddingConfigHash("openai", "custom", 1024, "https://two.example/v1"));
    expect(first).not.toBe(embeddingConfigHash("openai", "custom", 1024, "https://one.example/v2"));
  });

  it("does not include raw endpoints, credentials, queries, or fragments", () => {
    const hash = embeddingConfigHash(
      "openai",
      "custom",
      1024,
      "https://user:password@example.com/v1?api_key=secret#private",
    );
    expect(hash).not.toContain("example.com");
    expect(hash).not.toContain("password");
    expect(hash).not.toContain("api_key");
    expect(hash).not.toContain("private");
    expect(hash).toBe(embeddingConfigHash("openai", "custom", 1024, "https://example.com/v1"));
  });
});
