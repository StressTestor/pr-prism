import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JevDecisionStore } from "../decisions/decision-store.js";
import type { JevFirstDecisionRecord } from "../decisions/triage-v2.js";
import {
  buildClusterMembershipMap,
  buildDecisionMap,
  buildWorklist,
  computeDecisionFreshness,
  computeItemInputHash,
  computeReviewFreshness,
  DefaultMaintainerAdapter,
  filterWorklist,
  getReviewResult,
  getStoreItem,
  getStoreItems,
  type MaintainerItem,
  paginateWorklist,
  sortWorklist,
} from "../maintainer/index.js";
import { VectorStore } from "../store.js";
import type { Cluster, PRItem, ScoredPR, StoreItem } from "../types.js";

const TEST_DB = resolve(process.cwd(), "data", "test-maintainer.db");
const TEST_JEV_DB = resolve(process.cwd(), "data", "test-maintainer-jev.db");

function cleanupDbs() {
  for (const p of [
    TEST_DB,
    `${TEST_DB}-wal`,
    `${TEST_DB}-shm`,
    TEST_JEV_DB,
    `${TEST_JEV_DB}-wal`,
    `${TEST_JEV_DB}-shm`,
  ]) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

function makePR(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 1,
    type: "pr",
    repo: "owner/repo",
    title: "Fix null pointer in parser",
    body: "Resolves a crash when input is empty",
    state: "open",
    author: "developer",
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-01T12:00:00Z",
    labels: ["bug"],
    additions: 15,
    deletions: 2,
    hasTests: true,
    ciStatus: "success",
    ...overrides,
  };
}

function makeStoreItem(pr: PRItem): StoreItem {
  return {
    id: `${pr.repo}:${pr.type}:${pr.number}`,
    type: pr.type,
    number: pr.number,
    repo: pr.repo,
    title: pr.title,
    bodySnippet: pr.body,
    embedding: new Float32Array([0.1, 0.2, 0.3]),
    metadata: {
      author: pr.author,
      state: pr.state,
      labels: pr.labels,
      additions: pr.additions,
      deletions: pr.deletions,
      hasTests: pr.hasTests,
      ciStatus: pr.ciStatus,
      closesIssues: pr.closesIssues,
      headRefOid: pr.headRefOid,
    },
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
  };
}

function makeDecisionRecord(pr: PRItem, overrides: Partial<JevFirstDecisionRecord> = {}): JevFirstDecisionRecord {
  const inputHash = computeItemInputHash(pr);
  return {
    item: {
      repo: pr.repo,
      number: pr.number,
      type: pr.type,
      title: pr.title,
      fullBodyLength: pr.body.length,
      effectiveBodyLength: pr.body.length,
      isInputTruncated: false,
    },
    classification: {
      itemType: pr.type,
      category: "bug",
      categoryConfidence: 0.95,
      categoryProbabilities: { bug: 0.95, feature: 0.05 },
      technicalDomain: "core",
      technicalDomainConfidence: 0.88,
    },
    derived: {
      priorityTier: "high",
      complexityTier: "simple",
      riskFlags: ["none"],
    },
    scores: {
      operationalPriorityRaw: 2,
      operationalPriorityNorm: 0.67,
      operationalPriorityConfidence: 0.9,
      urgentBlockerProb: 0.1,
      securityVulnerabilityProb: 0.05,
      privacyOrPiiProb: 0.01,
      dataLossOrCorruptionProb: 0.02,
      maxSafetyRiskProb: 0.05,
      breakingChangeProb: 0.05,
      productionImpactRaw: 1,
      productionImpactNorm: 0.5,
      productionImpactConfidence: 0.8,
      changeComplexityRaw: 0,
      changeComplexityNorm: 0.2,
      changeComplexityConfidence: 0.85,
      reproductionEvidenceRaw: 2,
      reproductionEvidenceNorm: 0.8,
      reproductionEvidenceConfidence: 0.9,
      missingInformationProb: 0.1,
      goalRelevanceRaw: 2,
      goalRelevanceNorm: 0.8,
      goalRelevanceConfidence: 0.85,
      needsDeepReviewProb: 0.2,
    },
    routing: {
      advisory: true,
      escalateToDeepReview: false,
      advisoryRoute: "routine_review",
      escalationReasons: [],
      deterministicSafetyGates: [],
      uncertaintyFlags: [],
    },
    rawAnswers: {},
    provenance: {
      provider: "jev",
      model: "jev-1.14.0",
      inputHash,
      decisionSchemaVersion: "2.0.0",
      rubricHash: "rubric_123",
      decisionIdentity: `id_${pr.number}`,
      estimatedCostUsd: 0.0001,
      evaluatedAt: "2026-10-01T12:05:00Z",
    },
    ...overrides,
  };
}

describe("Maintainer Workbench Module", () => {
  let store: VectorStore;
  let jevStore: JevDecisionStore;

  beforeEach(() => {
    cleanupDbs();
    store = new VectorStore(TEST_DB, 3);
    jevStore = new JevDecisionStore(TEST_JEV_DB);
  });

  afterEach(() => {
    store.close();
    jevStore.close();
    cleanupDbs();
  });

  describe("Store Adapter", () => {
    it("reads items and individual item by number", () => {
      const pr1 = makePR({ number: 101, title: "PR 101" });
      const pr2 = makePR({ number: 102, title: "PR 102" });
      store.upsert(makeStoreItem(pr1));
      store.upsert(makeStoreItem(pr2));

      const items = getStoreItems(store, "owner/repo");
      expect(items).toHaveLength(2);

      const single = getStoreItem(store, "owner/repo", 101);
      expect(single).toBeDefined();
      expect(single?.number).toBe(101);
      expect(single?.title).toBe("PR 101");
      expect(single?.author).toBe("developer");

      const notFound = getStoreItem(store, "owner/repo", 999);
      expect(notFound).toBeUndefined();
    });
  });

  describe("Decision Adapter", () => {
    it("computes decision freshness: fresh, stale, none", () => {
      const pr = makePR({ number: 200, updatedAt: "2026-10-01T12:00:00Z" });
      const record = makeDecisionRecord(pr);

      // Matches exactly
      expect(computeDecisionFreshness(record, pr)).toBe("fresh");

      // None if missing
      expect(computeDecisionFreshness(undefined, pr)).toBe("none");

      // Stale if updatedAt or state or title changed
      const updatedPr = { ...pr, updatedAt: "2026-10-02T15:00:00Z" };
      expect(computeDecisionFreshness(record, updatedPr)).toBe("stale");

      const titleChangedPr = { ...pr, title: "New title" };
      expect(computeDecisionFreshness(record, titleChangedPr)).toBe("stale");
    });

    it("stores and maps Jev decisions", () => {
      const pr1 = makePR({ number: 10 });
      const record = makeDecisionRecord(pr1);
      jevStore.upsertDecision(record);

      const map = buildDecisionMap(jevStore, "owner/repo");
      expect(map.size).toBe(1);
      expect(map.get(10)?.classification.category).toBe("bug");
    });
  });

  describe("Cluster Adapter", () => {
    it("builds cluster membership map distinguishing canonical bestPick and duplicates", () => {
      const pr1: ScoredPR = {
        ...makePR({ number: 1, title: "First PR" }),
        score: 0.9,
        signals: {} as any,
      };
      const pr2: ScoredPR = {
        ...makePR({ number: 2, title: "Second PR" }),
        score: 0.6,
        signals: {} as any,
      };

      const identityCluster: Cluster = {
        id: 1,
        items: [pr1, pr2],
        bestPick: pr1,
        avgSimilarity: 1.0,
        minSimilarity: 0.95,
        theme: "Identical fix",
        kind: "identity",
        identity: { basis: "head-oid", key: "sha123" },
      };

      const map = buildClusterMembershipMap([identityCluster]);
      expect(map.size).toBe(2);

      const mem1 = map.get(1);
      expect(mem1).toBeDefined();
      expect(mem1?.clusterId).toBe(1);
      expect(mem1?.clusterSize).toBe(2);
      expect(mem1?.isBestPick).toBe(true);
      expect(mem1?.isConfirmedDuplicate).toBe(true);
      expect(mem1?.confidence).toBe("high");

      const mem2 = map.get(2);
      expect(mem2).toBeDefined();
      expect(mem2?.isBestPick).toBe(false);
      expect(mem2?.isConfirmedDuplicate).toBe(true);
    });
  });

  describe("Review Adapter", () => {
    it("handles present and missing reviews", () => {
      const empty = getReviewResult(store, "owner/repo", 55);
      expect(empty.hasReview).toBe(false);
      expect(empty.recommendation).toBeNull();
      expect(empty.findingsCount).toBe(0);

      store.saveReview("owner/repo", 55, "pr", "openai", "gpt-4", {
        summary: "Clean implementation with strong test coverage",
        concerns: ["Needs documentation for new CLI flag"],
        recommendation: "revise",
        confidence: 0.85,
      });

      const res = getReviewResult(store, "owner/repo", 55);
      expect(res.hasReview).toBe(true);
      expect(res.recommendation).toBe("revise");
      expect(res.confidence).toBe(0.85);
      expect(res.summary).toContain("Clean implementation");
      expect(res.findingsCount).toBe(1);
    });

    it("computes review freshness correctly", () => {
      expect(computeReviewFreshness(undefined, "2026-10-01T12:00:00Z")).toBe("none");
      expect(computeReviewFreshness("2026-10-01T13:00:00Z", "2026-10-01T12:00:00Z")).toBe("fresh");
      expect(computeReviewFreshness("2026-10-01T11:00:00Z", "2026-10-01T12:00:00Z")).toBe("stale");
    });
  });

  describe("Worklist Builder & Action Derivations", () => {
    it("derives suggestedAction: close_duplicate on confirmed non-canonical duplicates", () => {
      const pr1: ScoredPR = { ...makePR({ number: 1 }), score: 0.8, signals: {} as any };
      const pr2: ScoredPR = { ...makePR({ number: 2 }), score: 0.5, signals: {} as any };

      store.upsert(makeStoreItem(pr1));
      store.upsert(makeStoreItem(pr2));

      const clusters: Cluster[] = [
        {
          id: 10,
          items: [pr1, pr2],
          bestPick: pr1,
          avgSimilarity: 1.0,
          minSimilarity: 0.95,
          theme: "Identical fix",
          kind: "identity",
        },
      ];

      const worklist = buildWorklist({ store, repo: "owner/repo", clusters });
      const item2 = worklist.items.find((i) => i.number === 2);
      expect(item2).toBeDefined();
      expect(item2?.isConfirmedDuplicate).toBe(true);
      expect(item2?.suggestedAction).toBe("close_duplicate");
      expect(item2?.readyForAction).toBe(true);

      const item1 = worklist.items.find((i) => i.number === 1);
      expect(item1?.isConfirmedDuplicate).toBe(false);
      expect(item1?.suggestedAction).not.toBe("close_duplicate");
    });

    it("derives suggestedAction: close_superseded when tracker issue or sibling PR is closed/merged", () => {
      const pr = makePR({ number: 20, closesIssues: [42] });
      const closedIssue = makePR({ number: 42, type: "issue", state: "closed" });

      store.upsert(makeStoreItem(pr));
      store.upsert(makeStoreItem(closedIssue));

      const worklist = buildWorklist({ store, repo: "owner/repo", clusters: [] });
      const item20 = worklist.items.find((i) => i.number === 20);
      expect(item20?.isSupersededCandidate).toBe(true);
      expect(item20?.suggestedAction).toBe("close_superseded");
      expect(item20?.readyForAction).toBe(true);
    });

    it("derives suggestedAction: request_info on missing information", () => {
      const pr = makePR({ number: 30 });
      store.upsert(makeStoreItem(pr));

      const decision = makeDecisionRecord(pr, {
        scores: {
          ...makeDecisionRecord(pr).scores,
          missingInformationProb: 0.85,
        },
      });
      jevStore.upsertDecision(decision);

      const worklist = buildWorklist({ store, repo: "owner/repo", clusters: [], jevStore });
      const item30 = worklist.items.find((i) => i.number === 30);
      expect(item30?.missingInformation).toBe(true);
      expect(item30?.suggestedAction).toBe("request_info");
      expect(item30?.readyForAction).toBe(true);
    });

    it("derives suggestedAction: request_changes on review recommendation revise", () => {
      const pr = makePR({ number: 40 });
      store.upsert(makeStoreItem(pr));
      store.saveReview("owner/repo", 40, "pr", "openai", "gpt-4", {
        summary: "Needs unit tests for edge cases",
        concerns: ["Edge cases not covered"],
        recommendation: "revise",
        confidence: 0.9,
      });

      const worklist = buildWorklist({ store, repo: "owner/repo", clusters: [] });
      const item40 = worklist.items.find((i) => i.number === 40);
      expect(item40?.reviewRecommendation).toBe("revise");
      expect(item40?.suggestedAction).toBe("request_changes");
      expect(item40?.readyForAction).toBe(true);
    });

    it("derives suggestedAction: needs_deep_review on escalateToDeepReview without review", () => {
      const pr = makePR({ number: 50 });
      store.upsert(makeStoreItem(pr));

      const decision = makeDecisionRecord(pr, {
        routing: {
          ...makeDecisionRecord(pr).routing,
          escalateToDeepReview: true,
          advisoryRoute: "expert_investigation",
        },
      });
      jevStore.upsertDecision(decision);

      const worklist = buildWorklist({ store, repo: "owner/repo", clusters: [], jevStore });
      const item50 = worklist.items.find((i) => i.number === 50);
      expect(item50?.escalateToDeepReview).toBe(true);
      expect(item50?.hasDeepReview).toBe(false);
      expect(item50?.suggestedAction).toBe("needs_deep_review");
      expect(item50?.readyForAction).toBe(true);
    });

    it("derives suggestedAction: ready_to_merge on review recommendation merge", () => {
      const pr = makePR({ number: 60 });
      store.upsert(makeStoreItem(pr));
      store.saveReview("owner/repo", 60, "pr", "openai", "gpt-4", {
        summary: "Looks ready to land",
        concerns: [],
        recommendation: "merge",
        confidence: 0.95,
      });

      const worklist = buildWorklist({ store, repo: "owner/repo", clusters: [] });
      const item60 = worklist.items.find((i) => i.number === 60);
      expect(item60?.suggestedAction).toBe("ready_to_merge");
      expect(item60?.readyForAction).toBe(true);
    });

    it("derives suggestedAction: monitor and readyForAction: false by default", () => {
      const pr = makePR({ number: 70 });
      store.upsert(makeStoreItem(pr));

      const worklist = buildWorklist({ store, repo: "owner/repo", clusters: [] });
      const item70 = worklist.items.find((i) => i.number === 70);
      expect(item70?.suggestedAction).toBe("monitor");
      expect(item70?.readyForAction).toBe(false);
    });

    it("populates sourceBackedFacts and modelRecommendations", () => {
      const pr = makePR({ number: 80, author: "alice" });
      store.upsert(makeStoreItem(pr));

      const decision = makeDecisionRecord(pr, {
        derived: {
          priorityTier: "critical",
          complexityTier: "simple",
          riskFlags: ["security"],
        },
      });
      jevStore.upsertDecision(decision);

      const worklist = buildWorklist({ store, repo: "owner/repo", clusters: [], jevStore });
      const item = worklist.items[0];

      expect(item.sourceBackedFacts.some((f) => f.includes("state: open"))).toBe(true);
      expect(item.sourceBackedFacts.some((f) => f.includes("author: alice"))).toBe(true);

      expect(item.modelRecommendations.some((r) => r.includes("category: bug"))).toBe(true);
      expect(item.modelRecommendations.some((r) => r.includes("urgency: critical"))).toBe(true);
      expect(item.modelRecommendations.some((r) => r.includes("security risk"))).toBe(true);
    });
  });

  describe("Filtering, Sorting & Pagination", () => {
    it("filters across multiple dimensions", () => {
      const items: MaintainerItem[] = [
        {
          repo: "owner/repo",
          number: 1,
          type: "pr",
          url: "https://github.com/owner/repo/pull/1",
          title: "PR 1",
          state: "open",
          author: "alice",
          createdAt: "2026-10-01T10:00:00Z",
          updatedAt: "2026-10-01T10:00:00Z",
          labels: [],
          category: "security",
          categoryConfidence: 0.9,
          urgency: "critical",
          technicalDomain: "auth",
          advisoryRoute: "deep_review",
          escalateToDeepReview: true,
          evidenceQuality: 0.8,
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
          hasDeepReview: false,
          deepReviewAge: "none",
          reviewRecommendation: null,
          reviewConfidence: null,
          qualityScore: 0.85,
          suggestedAction: "needs_deep_review",
          readyForAction: true,
          sourceBackedFacts: [],
          modelRecommendations: [],
        },
        {
          repo: "owner/repo",
          number: 2,
          type: "issue",
          url: "https://github.com/owner/repo/issues/2",
          title: "Issue 2",
          state: "open",
          author: "bob",
          createdAt: "2026-10-01T11:00:00Z",
          updatedAt: "2026-10-01T11:00:00Z",
          labels: [],
          category: "bug",
          categoryConfidence: 0.8,
          urgency: "low",
          technicalDomain: "ui",
          advisoryRoute: "auto_triage",
          escalateToDeepReview: false,
          evidenceQuality: 0.4,
          securityRisk: false,
          breakingChangeRisk: false,
          dataLossRisk: false,
          missingInformation: true,
          hasJevDecision: true,
          jevDecisionAge: "stale",
          clusterId: null,
          clusterSize: 0,
          isDuplicateCandidate: false,
          isConfirmedDuplicate: false,
          isSupersededCandidate: false,
          clusterMinSimilarity: null,
          clusterConfidence: null,
          hasDeepReview: false,
          deepReviewAge: "none",
          reviewRecommendation: null,
          reviewConfidence: null,
          qualityScore: null,
          suggestedAction: "request_info",
          readyForAction: true,
          sourceBackedFacts: [],
          modelRecommendations: [],
        },
      ];

      // Filter by type
      expect(filterWorklist(items, { type: "pr" })).toHaveLength(1);
      expect(filterWorklist(items, { type: "issue" })).toHaveLength(1);

      // Filter by category
      expect(filterWorklist(items, { category: "security" })).toHaveLength(1);
      expect(filterWorklist(items, { category: "documentation" })).toHaveLength(0);

      // Filter by risk
      expect(filterWorklist(items, { risk: "security" })).toHaveLength(1);
      expect(filterWorklist(items, { risk: "data_loss" })).toHaveLength(0);

      // Filter by urgency
      expect(filterWorklist(items, { urgency: "critical" })).toHaveLength(1);

      // Filter by needsInformation
      expect(filterWorklist(items, { needsInformation: true })).toHaveLength(1);

      // Filter by stale evidence
      expect(filterWorklist(items, { hasStaleEvidence: true })).toHaveLength(1);
      expect(filterWorklist(items, { hasStaleEvidence: false })).toHaveLength(1);
    });

    it("sorts deterministically by urgency, number, score, updatedAt, category", () => {
      const pr1 = makePR({ number: 10 });
      const pr2 = makePR({ number: 20 });
      const items: MaintainerItem[] = [
        {
          repo: pr1.repo,
          number: pr1.number,
          type: pr1.type,
          url: "",
          title: pr1.title,
          author: pr1.author,
          createdAt: pr1.createdAt,
          state: "open",
          labels: [],
          category: "bug",
          categoryConfidence: null,
          urgency: "low",
          technicalDomain: null,
          advisoryRoute: null,
          escalateToDeepReview: null,
          evidenceQuality: null,
          securityRisk: null,
          breakingChangeRisk: null,
          dataLossRisk: null,
          missingInformation: null,
          hasJevDecision: false,
          jevDecisionAge: "none",
          clusterId: null,
          clusterSize: 0,
          isDuplicateCandidate: false,
          isConfirmedDuplicate: false,
          isSupersededCandidate: false,
          clusterMinSimilarity: null,
          clusterConfidence: null,
          hasDeepReview: false,
          deepReviewAge: "none",
          reviewRecommendation: null,
          reviewConfidence: null,
          qualityScore: 0.3,
          suggestedAction: "monitor",
          readyForAction: false,
          sourceBackedFacts: [],
          modelRecommendations: [],
          updatedAt: "2026-10-01T00:00:00Z",
        },
        {
          repo: pr2.repo,
          number: pr2.number,
          type: pr2.type,
          url: "",
          title: pr2.title,
          author: pr2.author,
          createdAt: pr2.createdAt,
          state: "open",
          labels: [],
          category: "feature",
          categoryConfidence: null,
          urgency: "critical",
          technicalDomain: null,
          advisoryRoute: null,
          escalateToDeepReview: null,
          evidenceQuality: null,
          securityRisk: null,
          breakingChangeRisk: null,
          dataLossRisk: null,
          missingInformation: null,
          hasJevDecision: false,
          jevDecisionAge: "none",
          clusterId: null,
          clusterSize: 0,
          isDuplicateCandidate: false,
          isConfirmedDuplicate: false,
          isSupersededCandidate: false,
          clusterMinSimilarity: null,
          clusterConfidence: null,
          hasDeepReview: false,
          deepReviewAge: "none",
          reviewRecommendation: null,
          reviewConfidence: null,
          qualityScore: 0.9,
          suggestedAction: "monitor",
          readyForAction: false,
          sourceBackedFacts: [],
          modelRecommendations: [],
          updatedAt: "2026-10-02T00:00:00Z",
        },
      ];

      // Sort by urgency desc
      const sortedByUrgency = sortWorklist(items, { field: "urgency", direction: "desc" });
      expect(sortedByUrgency[0].number).toBe(20);

      // Sort by score asc
      const sortedByScore = sortWorklist(items, { field: "score", direction: "asc" });
      expect(sortedByScore[0].number).toBe(10);

      // Sort by updatedAt desc
      const sortedByDate = sortWorklist(items, { field: "updatedAt", direction: "desc" });
      expect(sortedByDate[0].number).toBe(20);

      // Sort by category asc
      const sortedByCategory = sortWorklist(items, { field: "category", direction: "asc" });
      expect(sortedByCategory[0].number).toBe(10);
    });

    it("paginates worklist correctly", () => {
      const items = [1, 2, 3, 4, 5].map((n) => ({ number: n }) as MaintainerItem);

      const page1 = paginateWorklist(items, { offset: 0, limit: 2 });
      expect(page1.items.map((i) => i.number)).toEqual([1, 2]);
      expect(page1.hasMore).toBe(true);

      const page2 = paginateWorklist(items, { offset: 2, limit: 2 });
      expect(page2.items.map((i) => i.number)).toEqual([3, 4]);
      expect(page2.hasMore).toBe(true);

      const page3 = paginateWorklist(items, { offset: 4, limit: 2 });
      expect(page3.items.map((i) => i.number)).toEqual([5]);
      expect(page3.hasMore).toBe(false);
    });
  });

  describe("MaintainerAdapterPort", () => {
    it("satisfies MaintainerAdapterPort interface", async () => {
      const pr = makePR({ number: 99 });
      store.upsert(makeStoreItem(pr));

      const adapter = new DefaultMaintainerAdapter({ store, clusters: [] });
      const items = await adapter.getItems("owner/repo");
      expect(items).toHaveLength(1);
      expect(items[0].number).toBe(99);
    });
  });
});
