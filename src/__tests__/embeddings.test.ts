import { describe, expect, it } from "vitest";
import { prepareEmbeddingText } from "../embeddings.js";

describe("prepareEmbeddingText", () => {
  it("formats PR with title and body", () => {
    const result = prepareEmbeddingText({ title: "Fix bug", body: "This fixes the login issue", type: "pr" });
    expect(result).toBe("Pull Request: Fix bug\n\nThis fixes the login issue");
  });

  it("formats issue without body", () => {
    const result = prepareEmbeddingText({ title: "Feature request", body: "", type: "issue" });
    expect(result).toBe("Issue: Feature request");
  });

  it("truncates long bodies to 2000 chars", () => {
    const longBody = "x".repeat(3000);
    const result = prepareEmbeddingText({ title: "Test", body: longBody, type: "pr" });
    expect(result.length).toBeLessThanOrEqual(2000 + "Pull Request: Test\n\n".length);
  });

  it("handles null-ish title", () => {
    const result = prepareEmbeddingText({ title: "", body: "body", type: "pr" });
    expect(result).toContain("Untitled");
  });
});
