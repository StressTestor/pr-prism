import { describe, expect, it, vi } from "vitest";
import { GitHubClient, restPRState } from "../github.js";
import { createWriteGate } from "../write-gate.js";

function fakeOctokit() {
  return {
    issues: {
      addLabels: vi.fn(async () => ({})),
      removeLabel: vi.fn(async () => ({})),
      getLabel: vi.fn(async () => {
        throw new Error("not found");
      }),
      createLabel: vi.fn(async () => ({})),
    },
  };
}

describe("GitHubClient write gate", () => {
  it("default (dry-run) gate does not call octokit for applyLabel or ensureLabel (leak fix)", async () => {
    const client = new GitHubClient("t", "o", "r"); // default gate is dry-run
    const oct = fakeOctokit();
    (client as unknown as { octokit: unknown }).octokit = oct;
    await client.applyLabel(5, "bug");
    await client.ensureLabel("bug", "ffffff", "desc");
    expect(oct.issues.addLabels).not.toHaveBeenCalled();
    expect(oct.issues.createLabel).not.toHaveBeenCalled();
  });

  it("an apply gate does call octokit", async () => {
    const client = new GitHubClient("t", "o", "r", createWriteGate("apply"));
    const oct = fakeOctokit();
    (client as unknown as { octokit: unknown }).octokit = oct;
    await client.applyLabel(5, "bug");
    await client.ensureLabel("bug", "ffffff", "desc");
    expect(oct.issues.addLabels).toHaveBeenCalledTimes(1);
    expect(oct.issues.createLabel).toHaveBeenCalledTimes(1);
  });
});

describe("restPRState (REST merged detection)", () => {
  it("maps a PR with merged_at to 'merged' (REST state is only open/closed)", () => {
    expect(restPRState({ state: "closed", merged_at: "2026-01-01T00:00:00Z" })).toBe("merged");
  });

  it("keeps the REST state when the PR is not merged", () => {
    expect(restPRState({ state: "open", merged_at: null })).toBe("open");
    expect(restPRState({ state: "closed", merged_at: null })).toBe("closed");
  });
});

// Test the CI status mapping logic (extracted from github.ts for testability)
function mapCIStatus(state: string | null | undefined): "success" | "failure" | "pending" | "unknown" {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

function hasTestFiles(filenames: string[]): boolean {
  return filenames.some((f) => /test|spec|__tests__/i.test(f));
}

describe("mapCIStatus", () => {
  it("maps SUCCESS to success", () => {
    expect(mapCIStatus("SUCCESS")).toBe("success");
  });

  it("maps FAILURE to failure", () => {
    expect(mapCIStatus("FAILURE")).toBe("failure");
  });

  it("maps ERROR to failure", () => {
    expect(mapCIStatus("ERROR")).toBe("failure");
  });

  it("maps PENDING to pending", () => {
    expect(mapCIStatus("PENDING")).toBe("pending");
  });

  it("maps EXPECTED to pending", () => {
    expect(mapCIStatus("EXPECTED")).toBe("pending");
  });

  it("maps null to unknown", () => {
    expect(mapCIStatus(null)).toBe("unknown");
    expect(mapCIStatus(undefined)).toBe("unknown");
  });
});

describe("hasTestFiles", () => {
  it("detects test files", () => {
    expect(hasTestFiles(["src/index.ts", "src/__tests__/index.test.ts"])).toBe(true);
    expect(hasTestFiles(["src/foo.spec.js"])).toBe(true);
    expect(hasTestFiles(["test/unit.js"])).toBe(true);
  });

  it("returns false when no test files", () => {
    expect(hasTestFiles(["src/index.ts", "src/utils.ts", "README.md"])).toBe(false);
  });

  it("handles empty array", () => {
    expect(hasTestFiles([])).toBe(false);
  });
});

describe("GraphQL response → PRItem mapping", () => {
  it("correctly maps a full GraphQL PR node", () => {
    const node = {
      number: 42,
      title: "Fix auth flow",
      body: "Fixes the login redirect issue",
      state: "OPEN",
      author: { login: "testuser" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      additions: 50,
      deletions: 10,
      changedFiles: 3,
      labels: { nodes: [{ name: "bug" }] },
      reviews: { totalCount: 2 },
      files: {
        totalCount: 3,
        nodes: [{ path: "src/auth.ts" }, { path: "src/__tests__/auth.test.ts" }, { path: "README.md" }],
      },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    };

    // Simulate the mapping from fetchPRsGraphQL
    const fileNodes: string[] = node.files.nodes.map((f) => f.path);
    const foundTests = hasTestFiles(fileNodes);
    const hasTests = foundTests ? true : node.files.totalCount > 100 ? undefined : false;
    const ciStatus = mapCIStatus(node.commits.nodes[0].commit.statusCheckRollup.state);

    expect(ciStatus).toBe("success");
    expect(hasTests).toBe(true);
    expect(node.reviews.totalCount).toBe(2);
    expect(node.state.toLowerCase()).toBe("open");
    expect(node.labels.nodes.map((l: any) => l.name)).toEqual(["bug"]);
  });

  it("handles truncated file list (100+ files, no tests in first 100)", () => {
    const fileNodes = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`);
    const fileTotalCount = 150;
    const foundTests = hasTestFiles(fileNodes);
    // 100+ files and no test found — default to undefined (neutral)
    const hasTests = foundTests ? true : fileTotalCount > 100 ? undefined : false;
    expect(hasTests).toBeUndefined();
  });

  it("handles truncated file list (100+ files, tests found in first 100)", () => {
    const fileNodes = [...Array.from({ length: 99 }, (_, i) => `src/file${i}.ts`), "src/__tests__/foo.test.ts"];
    const fileTotalCount = 150;
    const foundTests = hasTestFiles(fileNodes);
    const hasTests = foundTests ? true : fileTotalCount > 100 ? undefined : false;
    expect(hasTests).toBe(true);
  });
});

describe("mapClosingIssues", () => {
  it("maps closingIssuesReferences nodes to issue numbers", async () => {
    const { mapClosingIssues } = await import("../github.js");
    expect(mapClosingIssues({ nodes: [{ number: 7 }, { number: 8 }] })).toEqual([7, 8]);
  });

  it("returns known-empty (not undefined) for missing or empty refs", async () => {
    const { mapClosingIssues } = await import("../github.js");
    expect(mapClosingIssues({ nodes: [] })).toEqual([]);
    expect(mapClosingIssues(null)).toEqual([]);
    expect(mapClosingIssues(undefined)).toEqual([]);
  });
});
