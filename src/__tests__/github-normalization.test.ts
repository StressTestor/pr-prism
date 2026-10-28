import { describe, expect, it } from "vitest";
import {
  accountIsBot,
  determineHasTests,
  hasTestFiles,
  itemClosedAt,
  mapCheckRunsToCIStatus,
  mapCIStatus,
  mapClosingIssues,
  normalizeGraphQLIssue,
  normalizeGraphQLPR,
  normalizeRestIssue,
  normalizeRestPR,
  restPRState,
} from "../github/normalization/index.js";

describe("Metadata normalizers - partial and missing data", () => {
  it("normalizes GraphQL PR with missing optional fields without throwing", () => {
    const raw: any = {
      number: 1,
      id: "node_1",
      title: "PR title",
      state: "OPEN",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      // body missing
      // author missing
      // labels missing
      // reviews missing
      // files missing
      // commits missing
      // closingIssuesReferences missing
    };

    const item = normalizeGraphQLPR(raw, "owner/repo");
    expect(item.number).toBe(1);
    expect(item.body).toBe("");
    expect(item.author).toBe("unknown");
    expect(item.authorIsBot).toBeUndefined();
    expect(item.labels).toEqual([]);
    expect(item.reviewCount).toBe(0);
    expect(item.ciStatus).toBe("unknown");
    expect(item.hasTests).toBe(false);
    expect(item.closesIssues).toEqual([]);
    expect(item.closedAt).toBeUndefined();
  });

  it("normalizes GraphQL Issue with missing author and body", () => {
    const raw: any = {
      number: 2,
      id: "issue_node_2",
      title: "Issue title",
      state: "CLOSED",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      closedAt: "2026-01-02T00:00:00Z",
    };

    const item = normalizeGraphQLIssue(raw, "owner/repo");
    expect(item.number).toBe(2);
    expect(item.type).toBe("issue");
    expect(item.body).toBe("");
    expect(item.author).toBe("unknown");
    expect(item.authorIsBot).toBeUndefined();
    expect(item.state).toBe("closed");
    expect(item.closedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("normalizes REST PR with string labels and missing body", () => {
    const raw: any = {
      number: 3,
      node_id: "rest_pr_3",
      title: "REST PR",
      state: "open",
      user: null, // deleted account
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      labels: ["bug", "help-wanted"], // strings instead of objects
      head: { sha: "abc" },
    };

    const item = normalizeRestPR(raw, "owner/repo");
    expect(item.author).toBe("unknown");
    expect(item.authorIsBot).toBeUndefined();
    expect(item.labels).toEqual(["bug", "help-wanted"]);
    expect(item.body).toBe("");
    expect(item.headRefOid).toBe("abc");
  });

  it("normalizes REST Issue with missing labels and author", () => {
    const raw: any = {
      number: 4,
      node_id: "rest_issue_4",
      title: "REST Issue",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    };

    const item = normalizeRestIssue(raw, "owner/repo");
    expect(item.author).toBe("unknown");
    expect(item.labels).toEqual([]);
    expect(item.body).toBe("");
  });
});

describe("State & CI normalization logic", () => {
  it("restPRState correctly handles null, undefined, or missing merged_at", () => {
    expect(restPRState({ state: "open" })).toBe("open");
    expect(restPRState({ state: "closed" })).toBe("closed");
    expect(restPRState({ state: "closed", merged_at: null })).toBe("closed");
    expect(restPRState({ state: "closed", merged_at: "2026-01-01T00:00:00Z" })).toBe("merged");
  });

  it("mapCIStatus handles all GitHub commit check rollup states", () => {
    expect(mapCIStatus("SUCCESS")).toBe("success");
    expect(mapCIStatus("FAILURE")).toBe("failure");
    expect(mapCIStatus("ERROR")).toBe("failure");
    expect(mapCIStatus("PENDING")).toBe("pending");
    expect(mapCIStatus("EXPECTED")).toBe("pending");
    expect(mapCIStatus("UNKNOWN_STATE")).toBe("unknown");
    expect(mapCIStatus(null)).toBe("unknown");
    expect(mapCIStatus(undefined)).toBe("unknown");
  });

  it("mapCheckRunsToCIStatus maps combinations of check run statuses", () => {
    expect(mapCheckRunsToCIStatus(0, [])).toBe("unknown");
    expect(mapCheckRunsToCIStatus(1, [{ status: "in_progress", conclusion: null }])).toBe("pending");
    expect(
      mapCheckRunsToCIStatus(2, [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ]),
    ).toBe("success");
    expect(
      mapCheckRunsToCIStatus(2, [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "neutral" },
      ]),
    ).toBe("failure");
  });

  it("itemClosedAt extracts closed timestamps correctly", () => {
    expect(itemClosedAt({ closed_at: "2026-02-01T00:00:00Z" })).toBe("2026-02-01T00:00:00Z");
    expect(itemClosedAt({ closedAt: "2026-02-01T00:00:00Z" })).toBe("2026-02-01T00:00:00Z");
    expect(itemClosedAt({})).toBeUndefined();
  });

  it("hasTestFiles matches test patterns", () => {
    expect(hasTestFiles(["src/math.ts", "src/math.test.ts"])).toBe(true);
    expect(hasTestFiles(["src/math.ts"])).toBe(false);
  });

  it("determineHasTests respects 100-file threshold and presence of test files", () => {
    expect(determineHasTests(["test/foo.ts"], 5)).toBe(true);
    expect(determineHasTests(["src/foo.ts"], 5)).toBe(false);
    expect(determineHasTests(["src/foo.ts"], 101)).toBeUndefined();
    expect(determineHasTests(["src/foo.ts", "src/foo.spec.ts"], 150)).toBe(true);
  });

  it("accountIsBot preserves null/undefined semantics", () => {
    expect(accountIsBot(undefined)).toBeUndefined();
    expect(accountIsBot(null)).toBeUndefined();
    expect(accountIsBot({})).toBeUndefined();
    expect(accountIsBot({ type: "User" })).toBe(false);
    expect(accountIsBot({ __typename: "User" })).toBe(false);
    expect(accountIsBot({ type: "Bot" })).toBe(true);
    expect(accountIsBot({ __typename: "Bot" })).toBe(true);
  });

  it("mapClosingIssues filters strictly by exact repository full name", () => {
    const refs = {
      nodes: [
        { number: 1, repository: { nameWithOwner: "owner/repo" } },
        { number: 2, repository: { nameWithOwner: "owner/other" } },
        { number: 3, repository: { nameWithOwner: "other/repo" } },
        { number: 4, repository: { nameWithOwner: "owner/repo" } },
      ],
    };
    expect(mapClosingIssues(refs, "owner/repo")).toEqual([1, 4]);
  });
});
