import { describe, it, expect } from "vitest";
import { parseRepo } from "../config.js";

describe("parseRepo", () => {
  it("parses valid owner/repo", () => {
    expect(parseRepo("octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("throws on missing repo name", () => {
    expect(() => parseRepo("octocat")).toThrow("Invalid repo format");
  });

  it("throws on empty string", () => {
    expect(() => parseRepo("")).toThrow("Invalid repo format");
  });

  it("handles repos with dots and hyphens", () => {
    expect(parseRepo("my-org/my.repo-name")).toEqual({ owner: "my-org", repo: "my.repo-name" });
  });
});
