import { describe, expect, it } from "vitest";
import { isBotAuthor } from "../bots.js";
import type { PRItem } from "../types.js";

function item(author: string, authorIsBot?: boolean): PRItem {
  return {
    number: 1,
    type: "pr",
    repo: "test/repo",
    title: "t",
    body: "b",
    state: "open",
    author,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [],
    ...(authorIsBot === undefined ? {} : { authorIsBot }),
  };
}

describe("isBotAuthor", () => {
  it("trusts GitHub's own account type over the login", () => {
    // Authoritative when the scan recorded it.
    expect(isBotAuthor(item("dependabot", true))).toBe(true);
    expect(isBotAuthor(item("dependabot", false))).toBe(false);
  });

  it("falls back to the login suffix REST uses for apps", () => {
    expect(isBotAuthor(item("dependabot[bot]"))).toBe(true);
    expect(isBotAuthor(item("renovate[bot]"))).toBe(true);
    expect(isBotAuthor(item("github-actions[bot]"))).toBe(true);
  });

  it("falls back to known bare logins, which is what GraphQL returns", () => {
    // GraphQL gives `dependabot`, REST gives `dependabot[bot]`, same account.
    expect(isBotAuthor(item("dependabot"))).toBe(true);
    expect(isBotAuthor(item("dependabot-preview"))).toBe(true);
    expect(isBotAuthor(item("renovate"))).toBe(true);
  });

  it("tolerates the app/ prefix the gh CLI displays", () => {
    expect(isBotAuthor(item("app/dependabot"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBotAuthor(item("Dependabot[Bot]"))).toBe(true);
  });

  it("does not flag humans whose names merely contain a bot name", () => {
    expect(isBotAuthor(item("dependabot-fan"))).toBe(false);
    expect(isBotAuthor(item("robotics"))).toBe(false);
    expect(isBotAuthor(item("abbot"))).toBe(false);
    expect(isBotAuthor(item("RaresKeY"))).toBe(false);
  });

  it("does not flag the unknown-author placeholder", () => {
    // Both fetch paths fall back to "unknown" when GitHub returns no author.
    expect(isBotAuthor(item("unknown"))).toBe(false);
  });
});
