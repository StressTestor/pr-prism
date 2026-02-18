import { describe, expect, it } from "vitest";
import { parseRepo } from "../config.js";

describe("parseRepo", () => {
  it("parses valid owner/repo", () => {
    expect(parseRepo("octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("throws on missing repo name", () => {
    expect(() => parseRepo("octocat")).toThrow("invalid repo format");
  });

  it("throws on empty string", () => {
    expect(() => parseRepo("")).toThrow("invalid repo format");
  });

  it("handles repos with dots and hyphens", () => {
    expect(parseRepo("my-org/my.repo-name")).toEqual({ owner: "my-org", repo: "my.repo-name" });
  });

  it("strips https://github.com/ prefix", () => {
    expect(parseRepo("https://github.com/octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("strips github.com/ prefix without protocol", () => {
    expect(parseRepo("github.com/octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("strips .git suffix", () => {
    expect(parseRepo("https://github.com/octocat/hello-world.git")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("rejects extra path segments", () => {
    expect(() => parseRepo("octocat/hello/world")).toThrow("invalid repo format");
  });
});
