import { describe, expect, it } from "vitest";
import { parseCodeowners, suggestOwners } from "../routing.js";

// --- parseCodeowners ---

describe("parseCodeowners", () => {
  it("parses a valid CODEOWNERS file", () => {
    const content = `src/auth/    @alice @bob
src/api/     @charlie
*.ts         @dave`;

    const rules = parseCodeowners(content);

    expect(rules).toHaveLength(3);
    expect(rules[0]).toEqual({ pattern: "src/auth/", owners: ["alice", "bob"] });
    expect(rules[1]).toEqual({ pattern: "src/api/", owners: ["charlie"] });
    expect(rules[2]).toEqual({ pattern: "*.ts", owners: ["dave"] });
  });

  it("skips comments and empty lines", () => {
    const content = `# this is a comment
src/auth/    @alice

# another comment

src/api/     @bob`;

    const rules = parseCodeowners(content);

    expect(rules).toHaveLength(2);
    expect(rules[0].pattern).toBe("src/auth/");
    expect(rules[1].pattern).toBe("src/api/");
  });

  it("handles multiple owners per pattern", () => {
    const content = `src/core/ @alice @bob @charlie`;

    const rules = parseCodeowners(content);

    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["alice", "bob", "charlie"]);
  });

  it("returns empty array for empty content", () => {
    expect(parseCodeowners("")).toHaveLength(0);
    expect(parseCodeowners("   \n\n  ")).toHaveLength(0);
  });

  it("ignores lines without @ owners", () => {
    const content = `src/auth/ alice bob
src/api/ @charlie`;

    const rules = parseCodeowners(content);

    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe("src/api/");
  });
});

// --- suggestOwners ---

describe("suggestOwners", () => {
  const codeowners = `# Code owners
src/auth/    @alice @bob
src/api/     @charlie
*.ts         @dave
docs/        @eve`;

  it("suggests owners when issue mentions a matching file path", () => {
    const title = "Bug in authentication";
    const body = "There's a crash in src/auth/login.ts when the token expires.";

    const suggestions = suggestOwners(title, body, codeowners);

    expect(suggestions.length).toBeGreaterThanOrEqual(1);

    const logins = suggestions.map((s) => s.login);
    expect(logins).toContain("alice");
    expect(logins).toContain("bob");

    // check reason format
    const aliceSuggestion = suggestions.find((s) => s.login === "alice");
    expect(aliceSuggestion?.reason).toContain("CODEOWNERS");
    expect(aliceSuggestion?.reason).toContain("src/auth/");
  });

  it("suggests owners for wildcard extension matches", () => {
    const title = "TypeScript error in `config.ts`";
    const body = "The config.ts file has a type error.";

    const suggestions = suggestOwners(title, body, codeowners);

    const logins = suggestions.map((s) => s.login);
    expect(logins).toContain("dave");
  });

  it("returns empty array when no file paths are mentioned", () => {
    const title = "Please add dark mode";
    const body = "It would be great to have a dark theme option for the app.";

    const suggestions = suggestOwners(title, body, codeowners);

    expect(suggestions).toHaveLength(0);
  });

  it("returns empty array when CODEOWNERS is null", () => {
    const suggestions = suggestOwners(
      "Bug in src/auth/login.ts",
      "Crash on login",
      null,
    );

    expect(suggestions).toHaveLength(0);
  });

  it("returns empty array when CODEOWNERS is empty", () => {
    const suggestions = suggestOwners(
      "Bug in src/auth/login.ts",
      "Crash on login",
      "",
    );

    expect(suggestions).toHaveLength(0);
  });

  it("returns at most 3 suggestions", () => {
    const manyOwners = `src/ @alice
src/ @bob
src/ @charlie
src/ @dave
src/ @eve`;

    const suggestions = suggestOwners(
      "Issue in src/foo/bar.ts",
      "something broke",
      manyOwners,
    );

    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it("deduplicates owners across multiple matching rules", () => {
    const overlapping = `src/auth/ @alice
*.ts @alice`;

    const suggestions = suggestOwners(
      "Bug in src/auth/login.ts",
      "crash",
      overlapping,
    );

    const aliceCount = suggestions.filter((s) => s.login === "alice").length;
    expect(aliceCount).toBe(1);
  });

  it("matches paths mentioned in backticks", () => {
    const title = "Error in `src/api/routes.ts`";
    const body = "The endpoint returns 500.";

    const suggestions = suggestOwners(title, body, codeowners);

    const logins = suggestions.map((s) => s.login);
    expect(logins).toContain("charlie");
  });
});
