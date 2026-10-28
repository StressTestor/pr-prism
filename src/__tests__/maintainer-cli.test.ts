import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DuplicateClusterData,
  displayDuplicatesTerminal,
  displayPrepareTerminal,
  displayShowTerminal,
  formatDuplicatesMarkdown,
  formatPrepareMarkdown,
  formatShowMarkdown,
  formatWorklistMarkdown,
  formatWorklistTable,
  type MaintainerItem,
  type PrepareDraftData,
  type ShowItemData,
} from "../cli/formatting/maintainer.js";

const CLI_ENTRY = resolve(__dirname, "../cli.ts");

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI_ENTRY, ...args], {
      encoding: "utf-8",
      env: { ...process.env, NODE_ENV: "test" },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || "",
      exitCode: typeof err.status === "number" ? err.status : 1,
    };
  }
}

describe("PR-Prism Maintainer CLI Commands", () => {
  it("displays help for prism maintainer and lists all 5 subcommands", () => {
    const res = runCli(["maintainer", "--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/\bworklist\b/);
    expect(res.stdout).toMatch(/\bshow\b/);
    expect(res.stdout).toMatch(/\bduplicates\b/);
    expect(res.stdout).toMatch(/\bprepare\b/);
    expect(res.stdout).toMatch(/\breport\b/);
  });

  it("displays help for maintainer worklist with all required options", () => {
    const res = runCli(["maintainer", "worklist", "--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--repo");
    expect(res.stdout).toContain("--type");
    expect(res.stdout).toContain("--category");
    expect(res.stdout).toContain("--urgency");
    expect(res.stdout).toContain("--duplicates-only");
    expect(res.stdout).toContain("--needs-info");
    expect(res.stdout).toContain("--reviewed");
    expect(res.stdout).toContain("--sort");
    expect(res.stdout).toContain("--direction");
    expect(res.stdout).toContain("--page");
    expect(res.stdout).toContain("--limit");
    expect(res.stdout).toContain("--format");
  });

  it("displays help for maintainer show with all required options", () => {
    const res = runCli(["maintainer", "show", "--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--type");
    expect(res.stdout).toContain("--repo");
    expect(res.stdout).toContain("--format");
  });

  it("displays help for maintainer duplicates with all required options", () => {
    const res = runCli(["maintainer", "duplicates", "--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--repo");
    expect(res.stdout).toContain("--threshold");
    expect(res.stdout).toContain("--format");
    expect(res.stdout).toContain("--confirmed-only");
  });

  it("displays help for maintainer prepare with all required options", () => {
    const res = runCli(["maintainer", "prepare", "--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--type");
    expect(res.stdout).toContain("--repo");
    expect(res.stdout).toContain("--action");
    expect(res.stdout).toContain("--dry-run");
    expect(res.stdout).toContain("--format");
  });

  it("displays help for maintainer report with all required options", () => {
    const res = runCli(["maintainer", "report", "--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--repo");
    expect(res.stdout).toContain("--output");
    expect(res.stdout).toContain("--format");
    expect(res.stdout).toContain("--top");
  });
});

describe("Maintainer Formatting Helpers", () => {
  const sampleItems: MaintainerItem[] = [
    {
      repo: "owner/repo",
      number: 101,
      type: "pr",
      url: "https://github.com/owner/repo/pull/101",
      title: "Add resilient caching layer for database lookups in auth system",
      state: "open",
      author: "alice",
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-15T12:00:00Z",
      labels: ["bug", "auth"],
      category: "bug",
      categoryConfidence: 0.92,
      urgency: "critical",
      technicalDomain: "backend",
      advisoryRoute: "maintainer_triage",
      escalateToDeepReview: true,
      evidenceQuality: 0.85,
      securityRisk: true,
      breakingChangeRisk: false,
      dataLossRisk: false,
      missingInformation: false,
      hasJevDecision: true,
      jevDecisionAge: "fresh",
      clusterId: null,
      clusterSize: 0,
      isDuplicateCandidate: false,
      isConfirmedDuplicate: false,
      isSupersededCandidate: false,
      clusterMinSimilarity: null,
      clusterConfidence: null,
      hasDeepReview: true,
      deepReviewAge: "fresh",
      reviewRecommendation: "revise",
      reviewConfidence: 0.88,
      qualityScore: 0.76,
      suggestedAction: "request_changes",
      readyForAction: true,
      sourceBackedFacts: ["state: open"],
      modelRecommendations: ["category: bug"],
    },
  ];

  it("formatWorklistTable includes table columns, advisory indicators, and pagination", () => {
    const pagination = { page: 1, limit: 25, totalPages: 1, totalItems: 1 };
    const tableOut = formatWorklistTable(sampleItems, pagination);

    expect(tableOut).toContain("#101");
    expect(tableOut).toContain("PR");
    expect(tableOut).toContain("critical [advisory]");
    expect(tableOut).toContain("bug [advisory]");
    expect(tableOut).toContain("request_changes");
    expect(tableOut).toContain("Page 1 of 1 (1 items)");
  });

  it("formatWorklistMarkdown outputs valid GFM markdown table with pagination", () => {
    const pagination = { page: 1, limit: 25, totalPages: 1, totalItems: 1 };
    const mdOut = formatWorklistMarkdown(sampleItems, pagination);

    expect(mdOut).toContain("| # | Type | Title | Urgency | Category | Action | State | Review |");
    expect(mdOut).toContain("| #101 | pr |");
    expect(mdOut).toContain("critical [advisory]");
    expect(mdOut).toContain("*Page 1 of 1 (1 items)*");
  });

  it("formatShowMarkdown formats sections with advisory labels and model findings disclaimer", () => {
    const showData: ShowItemData = {
      number: 101,
      type: "pr",
      title: "Fix authentication token expiration race",
      url: "https://github.com/owner/repo/pull/101",
      state: "open",
      author: "bob",
      updatedAt: "2026-10-10",
      sourceFacts: [
        { label: "state", value: "open", source: "GitHub API" },
        { label: "quality score", value: "0.72", source: "scorer.ts" },
      ],
      advisory: [
        { label: "category", value: "bug", source: "Jev", confidence: 0.87 },
        { label: "urgency", value: "high", source: "Jev" },
      ],
      findings: [
        {
          severity: "high",
          category: "correctness",
          fileOrSymbol: "auth.ts",
          description: "Potential null reference when session expires",
          groundedEvidence: "const x = null",
        },
      ],
      suggestedAction: "request_changes",
    };

    const md = formatShowMarkdown(showData);
    expect(md).toContain("# PR #101: Fix authentication token expiration race");
    expect(md).toContain("## Source-Backed Facts");
    expect(md).toContain("- **state:** open *(GitHub API)*");
    expect(md).toContain("- **quality score:** 0.72 *(scorer.ts)*");
    expect(md).toContain("## Advisory (Model Recommendations)");
    expect(md).toContain("- **category:** bug *[Jev, confidence 87%] [advisory]*");
    expect(md).toContain("## Model Findings");
    expect(md).toContain("NOTE: The following are model suggestions, not independently verified defects.");
    expect(md).toContain("- **[high]** correctness in `auth.ts`: Potential null reference when session expires");
    expect(md).toContain("`const x = null` *(model-cited)*");
    expect(md).toContain("## Suggested Action");
    expect(md).toContain("→ **request_changes**");
  });

  it("displayShowTerminal renders without throwing", () => {
    const showData: ShowItemData = {
      number: 101,
      type: "pr",
      title: "Sample PR",
      url: "https://github.com/owner/repo/pull/101",
      state: "open",
      author: "alice",
      updatedAt: "2026-10-01",
      sourceFacts: [{ label: "state", value: "open", source: "GitHub API" }],
      advisory: [{ label: "category", value: "bug", source: "Jev" }],
      findings: [{ severity: "high", description: "Sample defect", groundedEvidence: "code" }],
      suggestedAction: "request_changes",
    };

    expect(() => displayShowTerminal(showData)).not.toThrow();
  });

  it("formatDuplicatesMarkdown and displayDuplicatesTerminal format identity and fuzzy tiers", () => {
    const clusters: DuplicateClusterData[] = [
      {
        id: "confirmed-1",
        theme: "Identical head OID",
        kind: "identity",
        confidenceTier: "confirmed",
        identityBasis: "head-oid",
        items: [
          { number: 10, title: "PR A", isBest: true },
          { number: 20, title: "PR B", isBest: false },
        ],
      },
      {
        id: 2,
        theme: "Fix database pool",
        kind: "fuzzy",
        confidenceTier: "high",
        minSimilarity: 0.91,
        avgSimilarity: 0.93,
        items: [
          { number: 30, title: "PR C", isBest: true, similarity: 0.93 },
          { number: 40, title: "PR D", isBest: false, similarity: 0.91 },
        ],
      },
    ];

    const md = formatDuplicatesMarkdown(clusters);
    expect(md).toContain("### ★ Confirmed Duplicate (head-oid)");
    expect(md).toContain("### Cluster #2: Fix database pool");
    expect(md).toContain("⚠ fuzzy — verify before closing");

    expect(() => displayDuplicatesTerminal(clusters)).not.toThrow();
  });

  it("formatPrepareMarkdown and displayPrepareTerminal include editable placeholders and disclaimer", () => {
    const draft: PrepareDraftData = {
      action: "request_info",
      number: 55,
      type: "issue",
      title: "Broken login",
      content: "Please provide reproduction steps.",
      placeholders: [{ placeholder: "<!-- EDIT: steps -->", description: "reproduction steps" }],
    };

    const md = formatPrepareMarkdown(draft);
    expect(md).toContain("<!-- DRAFT: Edit before submitting -->");
    expect(md).toContain("Please provide reproduction steps.");
    expect(md).toContain("Editable Placeholders:");
    expect(md).toContain("- <!-- EDIT: steps -->: reproduction steps");

    expect(() => displayPrepareTerminal(draft)).not.toThrow();
  });
});
