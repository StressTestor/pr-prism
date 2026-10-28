import { describe, expect, it } from "vitest";
import type { JevFirstDecisionRecord } from "../decisions/triage-v2.js";
import { formatIssueFinding, formatPrFinding } from "../maintainer/findings.js";
import type { PRItem } from "../types.js";

const mockPrItem: PRItem = {
  number: 42,
  type: "pr",
  repo: "odysseus-dev/odysseus",
  title: "Add rate limiting middleware",
  body: "Implements sliding window rate limiter",
  state: "open",
  author: "alice",
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-25T12:00:00Z",
  labels: ["enhancement"],
  additions: 120,
  deletions: 15,
};

const mockReviewWithFindings = {
  summary: "Comprehensive review of rate limiting PR",
  recommendation: "revise",
  confidence: 0.85,
  findings: [
    {
      severity: "high",
      category: "correctness",
      fileOrSymbol: "src/rate-limiter.ts",
      description: "Race condition in redis increment without TTL transaction",
      groundedEvidence: "await client.incr(key); await client.expire(key, 60);",
    },
  ],
  modelUncertainties: ["Redis cluster failover mode not verified"],
};

const mockJevRecord = {
  version: "1.0",
  classification: {
    category: "feature",
    categoryConfidence: 0.88,
    technicalDomain: "middleware",
  },
  scores: {
    securityRiskProb: 0.1,
    breakingChangeProb: 0.05,
    dataLossRiskProb: 0.0,
  },
  derived: {
    priorityTier: "medium",
    complexityTier: "moderate",
    riskFlags: [],
  },
  routing: {
    advisoryRoute: "backend-review",
    uncertaintyFlags: [],
    deterministicSafetyGates: [],
    escalationReasons: [],
  },
  provenance: {
    model: "mock-jev-v1",
    decisionIdentity: "test-identity",
    inputHash: "abc123",
  },
} as unknown as JevFirstDecisionRecord;

describe("formatPrFinding", () => {
  it("a model finding has a disclaimer about not being verified", () => {
    const finding = formatPrFinding(mockPrItem, { rawReview: mockReviewWithFindings });
    expect(finding.modelFindings[0].disclaimer).toContain("not independently verified");
  });

  it("sourceBackedFacts vs modelRecommendations are separated", () => {
    const finding = formatPrFinding(mockPrItem, { jevRecord: mockJevRecord });
    // State is source-backed
    expect(finding.sourceBackedFacts.some((f) => f.toLowerCase().includes("state"))).toBe(true);
    // Category is advisory
    expect(finding.modelRecommendations.some((f) => f.toLowerCase().includes("category"))).toBe(true);
  });

  it("fuzzy duplicate evidence note says it is a candidate only", () => {
    const finding = formatPrFinding(mockPrItem, {
      clusterMembership: {
        clusterId: 10,
        clusterSize: 2,
        isConfirmedDuplicate: false,
        minSimilarity: 0.82,
        confidence: "solid",
        relatedNumbers: [39],
      },
    });
    expect(finding.duplicateEvidence?.note).toContain("candidate signal only");
  });

  it("confirmed duplicate evidence note says confirmed", () => {
    const finding = formatPrFinding(mockPrItem, {
      clusterMembership: {
        clusterId: 10,
        clusterSize: 2,
        isConfirmedDuplicate: true,
        minSimilarity: 1.0,
        confidence: "high",
        relatedNumbers: [39],
      },
    });
    expect(finding.duplicateEvidence?.note).toContain("Confirmed");
  });

  it("incomplete review displays as incomplete, not successful", () => {
    // rawReview with missing required fields → reviewState: "incomplete"
    const finding = formatPrFinding(mockPrItem, { rawReview: { summary: "partial" } }); // missing recommendation
    expect(finding.reviewState).toBe("incomplete");
  });

  it("complete review displays as complete", () => {
    const finding = formatPrFinding(mockPrItem, { rawReview: mockReviewWithFindings });
    expect(finding.reviewState).toBe("complete");
  });
});

describe("formatIssueFinding", () => {
  const mockIssueItem: PRItem = {
    number: 77,
    type: "issue",
    repo: "odysseus-dev/odysseus",
    title: "Database connection dropped during reconnect",
    body: "Steps to reproduce: ...",
    state: "open",
    author: "bob",
    createdAt: "2026-10-21T08:00:00Z",
    updatedAt: "2026-10-25T11:00:00Z",
    labels: ["bug"],
  };

  it("formats issue finding with separated source facts and advisory recommendations", () => {
    const finding = formatIssueFinding(mockIssueItem, { jevRecord: mockJevRecord });
    expect(finding.sourceBackedFacts.some((f) => f.toLowerCase().includes("state"))).toBe(true);
    expect(finding.modelRecommendations.some((f) => f.toLowerCase().includes("category"))).toBe(true);
  });
});
