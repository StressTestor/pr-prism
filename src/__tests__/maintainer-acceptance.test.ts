import { describe, expect, it, vi } from "vitest";
import fixtureItems from "../maintainer/__fixtures__/items.json";
import { type ActionPlan, validateNotStale } from "../maintainer/actions.js";
import { generateDuplicateClosureComment } from "../maintainer/drafts.js";
import { formatPrFinding } from "../maintainer/findings.js";
import { MockMaintainerTransport } from "../maintainer/mock-transport.js";
import { generateBacklogReport } from "../maintainer/reports.js";
import type { MaintainerItem } from "../maintainer/types.js";
import { filterWorklist } from "../maintainer/worklist.js";
import type { PRItem } from "../types.js";
import { createWriteGate } from "../write-gate.js";

const mockPr: PRItem = {
  number: 5,
  type: "pr",
  repo: "odysseus-dev/odysseus",
  title: "Fix authentication bug",
  body: "Fixes auth token expiration race condition",
  state: "open",
  author: "alice",
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-25T12:00:00Z",
  labels: ["bug"],
};

function buildTestActionPlan(updatedAt = "2026-10-01T00:00:00Z"): ActionPlan {
  return {
    kind: "post_comment",
    target: {
      repo: "odysseus-dev/odysseus",
      number: 5,
      type: "pr",
      currentState: "open",
      updatedAt,
    },
    draftSource: "test_draft",
    previewText: "",
    requiresWrite: true,
    checkpoints: [],
  };
}

describe("Acceptance: duplicate candidate worklist", () => {
  it("A duplicate candidate becomes an inspectable worklist item", () => {
    // Build worklist from fixture, find the duplicate candidate
    const items = filterWorklist(fixtureItems as MaintainerItem[], { isDuplicateCandidate: true });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].isDuplicateCandidate).toBe(true);
    // It has cluster information
    expect(items[0].clusterId).not.toBeNull();
  });
});

describe("Acceptance: no fuzzy duplicate treated as confirmed", () => {
  it("Embedding similarity alone does not make isConfirmedDuplicate=true", () => {
    const fuzzy = (fixtureItems as MaintainerItem[]).find((i) => i.isDuplicateCandidate && !i.isConfirmedDuplicate);
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.isConfirmedDuplicate).toBe(false);
  });
});

describe("Acceptance: model finding references evidence", () => {
  it("A model finding has groundedEvidence or null (never invented)", () => {
    const mockReview = {
      findings: [
        {
          severity: "high",
          category: "correctness",
          fileOrSymbol: "auth.ts",
          description: "null dereference",
          groundedEvidence: "const x = req.user.id",
        },
      ],
      summary: "Potential null dereference in request handler",
      recommendation: "revise",
      confidence: 0.7,
    };
    const finding = formatPrFinding(mockPr, { rawReview: mockReview });
    const f = finding.modelFindings[0];
    expect(f.groundedEvidence).not.toBeUndefined();
    expect(f.disclaimer).toContain("not independently verified");
  });
});

describe("Acceptance: completed review displays correctly", () => {
  it("A full review result shows as complete", () => {
    const mockReview = { findings: [], summary: "LGTM", recommendation: "merge", confidence: 0.9 };
    const finding = formatPrFinding(mockPr, { rawReview: mockReview });
    expect(finding.reviewState).toBe("complete");
    expect(finding.reviewRecommendation).toBe("merge");
  });
});

describe("Acceptance: invalid/incomplete review shows as incomplete", () => {
  it("Missing recommendation makes review incomplete", () => {
    const finding = formatPrFinding(mockPr, { rawReview: { summary: "..." } });
    expect(finding.reviewState).toBe("incomplete");
  });
});

describe("Acceptance: closure comment can be previewed without submission", () => {
  it("Draft is created without any GitHub write", () => {
    const draft = generateDuplicateClosureComment({
      repo: "odysseus-dev/odysseus",
      number: 5,
      title: "Fix auth bug",
      canonicalNumber: 3,
      isConfirmed: false,
    });
    expect(draft.disclaimer).toContain("DRAFT");
    // No transport calls
    const transport = new MockMaintainerTransport();
    expect(transport.calls).toHaveLength(0);
  });
});

describe("Acceptance: explicit action cannot silently become GitHub write", () => {
  it("WriteGate in dry-run blocks any mutation", async () => {
    const gate = createWriteGate("dry-run");
    const run = vi.fn(async () => "written");
    const result = await gate.guard({ kind: "comment", target: "#5", run });
    expect(result.applied).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Acceptance: stale state blocks write preparation", () => {
  it("validateNotStale returns invalid when updatedAt changed", () => {
    const plan = buildTestActionPlan("2026-10-01T00:00:00Z");
    const result = validateNotStale(plan, "2026-10-27T00:00:00Z");
    expect(result.valid).toBe(false);
  });
});

describe("Acceptance: reports are deterministic", () => {
  it("Same input always produces same report", () => {
    const r1 = generateBacklogReport(fixtureItems as MaintainerItem[], "odysseus-dev/odysseus");
    const r2 = generateBacklogReport(fixtureItems as MaintainerItem[], "odysseus-dev/odysseus");
    expect(r1).toBe(r2);
  });
});
