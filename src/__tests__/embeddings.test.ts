import { describe, expect, it } from "vitest";
import { prepareEmbeddingText } from "../embeddings.js";

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
