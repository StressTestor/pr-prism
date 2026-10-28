import { describe, expect, it } from "vitest";
import { JevDecisionStore } from "../decisions/decision-store.js";
import {
  compareJevAgainstQwen,
  type EnrichedEvaluationItem,
  type QwenClassificationRow,
  selectStratifiedPilotSample,
} from "../decisions/evaluation-study.js";
import { MockDecisionProvider } from "../decisions/mock-provider.js";
import {
  composeJevFirstDecisionRecord,
  computeCredentialFingerprint,
  DEFAULT_JEV_FIRST_THRESHOLDS,
  estimateJevInferenceCostUsd,
  evaluateDeterministicSafetyGates,
  evaluateJevFirstItem,
  JEV_FIRST_CATEGORIES,
  JEV_FIRST_QUESTIONS,
  JEV_FIRST_SCHEMA_VERSION,
  type JevFirstDecisionRecord,
  resolveTypeSafeApiKey,
} from "../decisions/triage-v2.js";
import type { DecisionAnswer, DecisionProvenance } from "../decisions/types.js";
import type { PRItem } from "../types.js";

function createMockItem(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 101,
    type: "pr",
    repo: "odysseus-dev/odysseus",
    title: "Routine refactor of helper utilities",
    body: "This PR cleans up internal utility helpers without behavioral changes.",
    state: "open",
    author: "developer",
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
    labels: [],
    ...overrides,
  };
}

function createBenignAnswers(): Record<string, DecisionAnswer> {
  return {
    category: {
      type: "choice",
      choice: "documentation",
      confidence: 1.0,
      probabilities: { documentation: 1.0 },
    },
    technical_domain: {
      type: "choice",
      choice: "documentation",
      confidence: 0.95,
      probabilities: { documentation: 0.95, other: 0.05 },
    },
    operational_priority: {
      type: "score",
      score: 0,
      confidence: 0.98,
      probabilities: { "0": 0.98, "1": 0.02 },
    },
    is_urgent_blocker: {
      type: "noul",
      noul: 0.0,
    },
    security_vulnerability_risk: {
      type: "noul",
      noul: 0.0,
    },
    privacy_or_pii_risk: {
      type: "noul",
      noul: 0.0,
    },
    data_loss_or_corruption_risk: {
      type: "noul",
      noul: 0.0,
    },
    breaking_change_risk: {
      type: "noul",
      noul: 0.0,
    },
    production_impact: {
      type: "score",
      score: 0,
      confidence: 0.95,
      probabilities: { "0": 0.95, "1": 0.05 },
    },
    change_complexity: {
      type: "score",
      score: 0,
      confidence: 0.95,
      probabilities: { "0": 0.95, "1": 0.05 },
    },
    reproduction_evidence: {
      type: "score",
      score: 2,
      confidence: 0.9,
      probabilities: { "2": 0.9, "1": 0.1 },
    },
    missing_information: {
      type: "noul",
      noul: 0.0,
    },
    goal_relevance: {
      type: "score",
      score: 1,
      confidence: 0.9,
      probabilities: { "1": 0.9, "0": 0.1 },
    },
    needs_deep_review: {
      type: "noul",
      noul: 0.0,
    },
  };
}

function createMockProvenance(overrides: Partial<DecisionProvenance> = {}): DecisionProvenance {
  return {
    provider: "mock",
    model: "jev-1.14.0",
    inputHash: "input_hash_12345678",
    decisionSchemaVersion: JEV_FIRST_SCHEMA_VERSION,
    rubricHash: "rubric_hash_12345678",
    decisionIdentity: "mock_identity_101",
    usage: {
      inputTokens: 1000,
      outputTokens: 0,
    },
    latencyMs: 120,
    evaluatedAt: "2026-10-27T12:00:00Z",
    ...overrides,
  };
}

describe("Stage A — Jev-First Triage v2 & Safety Gates", () => {
  describe("Requirement 1: 14 Decomposed Questions Catalog", () => {
    it("verifies JEV_FIRST_SCHEMA_VERSION is 2.0.0", () => {
      expect(JEV_FIRST_SCHEMA_VERSION).toBe("2.0.0");
    });

    it("verifies JEV_FIRST_QUESTIONS contains exactly 14 decomposed primitives", () => {
      const questionKeys = Object.keys(JEV_FIRST_QUESTIONS);
      expect(questionKeys).toHaveLength(14);

      const expectedQuestions = [
        "category",
        "technical_domain",
        "operational_priority",
        "is_urgent_blocker",
        "security_vulnerability_risk",
        "privacy_or_pii_risk",
        "data_loss_or_corruption_risk",
        "breaking_change_risk",
        "production_impact",
        "change_complexity",
        "reproduction_evidence",
        "missing_information",
        "goal_relevance",
        "needs_deep_review",
      ];

      for (const q of expectedQuestions) {
        expect(JEV_FIRST_QUESTIONS[q]).toBeDefined();
      }
    });

    it("verifies question primitive types match Choice, Score, and Noul design", () => {
      // Choice primitives
      expect(JEV_FIRST_QUESTIONS.category.type).toBe("choice");
      expect((JEV_FIRST_QUESTIONS.category as any).criteria).toEqual(JEV_FIRST_CATEGORIES);
      expect(Object.keys(JEV_FIRST_CATEGORIES)).toHaveLength(11);

      expect(JEV_FIRST_QUESTIONS.technical_domain.type).toBe("choice");

      // Score primitives (with discrete criteria levels)
      expect(JEV_FIRST_QUESTIONS.operational_priority.type).toBe("score");
      expect((JEV_FIRST_QUESTIONS.operational_priority as any).criteria).toHaveLength(4); // 0..3

      expect(JEV_FIRST_QUESTIONS.production_impact.type).toBe("score");
      expect((JEV_FIRST_QUESTIONS.production_impact as any).criteria).toHaveLength(3); // 0..2

      expect(JEV_FIRST_QUESTIONS.change_complexity.type).toBe("score");
      expect((JEV_FIRST_QUESTIONS.change_complexity as any).criteria).toHaveLength(3); // 0..2

      expect(JEV_FIRST_QUESTIONS.reproduction_evidence.type).toBe("score");
      expect((JEV_FIRST_QUESTIONS.reproduction_evidence as any).criteria).toHaveLength(3); // 0..2

      expect(JEV_FIRST_QUESTIONS.goal_relevance.type).toBe("score");
      expect((JEV_FIRST_QUESTIONS.goal_relevance as any).criteria).toHaveLength(3); // 0..2

      // Noul primitives (binary probabilities with true/false criteria descriptions)
      const noulQuestions = [
        "is_urgent_blocker",
        "security_vulnerability_risk",
        "privacy_or_pii_risk",
        "data_loss_or_corruption_risk",
        "breaking_change_risk",
        "missing_information",
        "needs_deep_review",
      ];

      for (const qName of noulQuestions) {
        const qDef = JEV_FIRST_QUESTIONS[qName];
        expect(qDef.type).toBe("noul");
        expect((qDef as any).criteria).toBeDefined();
        expect((qDef as any).criteria.true).toBeTypeOf("string");
        expect((qDef as any).criteria.false).toBeTypeOf("string");
      }
    });

    it("verifies default routing thresholds provide balanced safeguards", () => {
      expect(DEFAULT_JEV_FIRST_THRESHOLDS.securityRisk).toBe(0.5);
      expect(DEFAULT_JEV_FIRST_THRESHOLDS.privacyRisk).toBe(0.5);
      expect(DEFAULT_JEV_FIRST_THRESHOLDS.dataLossRisk).toBe(0.5);
      expect(DEFAULT_JEV_FIRST_THRESHOLDS.breakingChangeRisk).toBe(0.55);
      expect(DEFAULT_JEV_FIRST_THRESHOLDS.urgentBlockerRisk).toBe(0.5);
      expect(DEFAULT_JEV_FIRST_THRESHOLDS.deepReviewProb).toBe(0.55);
      expect(DEFAULT_JEV_FIRST_THRESHOLDS.borderlineSafetyRisk).toBe(0.3);
    });
  });

  describe("Requirement 2: Deterministic Safety Gates", () => {
    it("triggers safety_gate:security on security keywords in title or labels", () => {
      const cases = [
        { title: "Fix CVE-2024-9999 remote code execution", labels: [] },
        { title: "Fix token validation in OAuth middleware", labels: [] },
        { title: "Sanitize unsanitized input to prevent XSS", labels: [] },
        { title: "Mitigate SSRF vulnerability in webhook dispatcher", labels: [] },
        { title: "Prevent privilege escalation in admin handler", labels: [] },
        { title: "Clean up helpers", labels: ["security"] },
        { title: "Update auth provider", labels: ["authentication"] },
        { title: "Patch exploit in query parser", labels: ["vuln"] },
      ];

      for (const c of cases) {
        const gates = evaluateDeterministicSafetyGates(createMockItem(c));
        expect(gates.some((g) => g.startsWith("safety_gate:security"))).toBe(true);
      }
    });

    it("triggers safety_gate:data_loss on data corruption or destructive keywords", () => {
      const cases = [
        { title: "Prevent data loss during sync compaction", labels: [] },
        { title: "Fix data corruption in WAL writer", labels: [] },
        { title: "Execute database drop table safely in dev", labels: [] },
        { title: "Prevent pii leak in user profile exporter", labels: [] },
        { title: "Fix memory consolidation race condition", labels: [] },
        { title: "Sync routine updates", labels: ["destructive"] },
      ];

      for (const c of cases) {
        const gates = evaluateDeterministicSafetyGates(createMockItem(c));
        expect(gates.some((g) => g.startsWith("safety_gate:data_loss"))).toBe(true);
      }
    });

    it("triggers safety_gate:breaking on breaking API or migration keywords", () => {
      const cases = [
        { title: "Breaking change: deprecate v1 REST endpoints", labels: [] },
        { title: "Incompatible API changes in client package", labels: [] },
        { title: "Breaking migration for user table schema", labels: [] },
        { title: "Drop backward compatibility for legacy configs", labels: [] },
        { title: "Update routes", labels: ["breaking-change"] },
      ];

      for (const c of cases) {
        const gates = evaluateDeterministicSafetyGates(createMockItem(c));
        expect(gates.some((g) => g.startsWith("safety_gate:breaking"))).toBe(true);
      }
    });

    it("triggers safety_gate:priority_label on critical/p0/p1/blocker labels", () => {
      const cases = [
        { labels: ["p0"] },
        { labels: ["P1"] },
        { labels: ["critical"] },
        { labels: ["blocker"] },
        { labels: ["severity: critical"] },
        { labels: ["priority: high"] },
      ];

      for (const c of cases) {
        const gates = evaluateDeterministicSafetyGates(createMockItem(c));
        expect(gates.some((g) => g.startsWith("safety_gate:priority_label"))).toBe(true);
      }
    });

    it("returns empty array for clean, benign items without safety keywords", () => {
      const item = createMockItem({
        title: "Improve docs formatting and add code examples",
        labels: ["documentation", "good-first-issue"],
      });
      const gates = evaluateDeterministicSafetyGates(item);
      expect(gates).toEqual([]);
    });
  });

  describe("Requirement 3: Hard Invariant — Deterministic Safety Gates Cannot Be Overridden", () => {
    it("enforces escalation to deep review and security_escalation even when Jev scores 0.00 risk and 1.00 documentation confidence", async () => {
      const item = createMockItem({
        title: "Security: fix token authorization bypass in session guard",
        labels: ["security"],
      });

      // Pure benign answers with 0.00 risk
      const answers = createBenignAnswers();
      const provenance = createMockProvenance();

      // 1. Test pure compose function
      const record = composeJevFirstDecisionRecord(item, answers, provenance);

      expect(record.routing.deterministicSafetyGates.length).toBeGreaterThan(0);
      expect(record.routing.escalateToDeepReview).toBe(true);
      expect(record.routing.advisoryRoute).toBe("security_escalation");
      expect(record.classification.category).toBe("documentation");
      expect(record.scores.securityVulnerabilityProb).toBe(0.0);
      expect(record.routing.escalationReasons).toContain(record.routing.deterministicSafetyGates[0]);

      // 2. Test full evaluateJevFirstItem pipeline with MockDecisionProvider
      const mockProvider = new MockDecisionProvider({ presetAnswers: answers });
      const evaluated = await evaluateJevFirstItem(item, mockProvider);

      expect(evaluated.routing.deterministicSafetyGates.length).toBeGreaterThan(0);
      expect(evaluated.routing.escalateToDeepReview).toBe(true);
      expect(evaluated.routing.advisoryRoute).toBe("security_escalation");
    });

    it("enforces escalation for data loss gates even when Jev returns 0.00 risk", () => {
      const item = createMockItem({
        title: "Handle database drop table and prevent data corruption",
      });

      const answers = createBenignAnswers();
      const provenance = createMockProvenance();

      const record = composeJevFirstDecisionRecord(item, answers, provenance);

      expect(record.routing.deterministicSafetyGates.some((g) => g.startsWith("safety_gate:data_loss"))).toBe(true);
      expect(record.routing.escalateToDeepReview).toBe(true);
      expect(record.routing.advisoryRoute).toBe("security_escalation");
    });

    it("enforces escalation for breaking change gates with advisoryRoute expert_investigation", () => {
      const item = createMockItem({
        title: "Breaking change: redesign client public API",
      });

      const answers = createBenignAnswers();
      const provenance = createMockProvenance();

      const record = composeJevFirstDecisionRecord(item, answers, provenance);

      expect(record.routing.deterministicSafetyGates.some((g) => g.startsWith("safety_gate:breaking"))).toBe(true);
      expect(record.routing.escalateToDeepReview).toBe(true);
      expect(record.routing.advisoryRoute).toBe("expert_investigation");
    });

    it("enforces escalation for priority label gates with advisoryRoute expert_investigation", () => {
      const item = createMockItem({
        title: "Routine polish",
        labels: ["p0"],
      });

      const answers = createBenignAnswers();
      const provenance = createMockProvenance();

      const record = composeJevFirstDecisionRecord(item, answers, provenance);

      expect(record.routing.deterministicSafetyGates.some((g) => g.startsWith("safety_gate:priority_label"))).toBe(
        true,
      );
      expect(record.routing.escalateToDeepReview).toBe(true);
      expect(record.routing.advisoryRoute).toBe("expert_investigation");
    });
  });

  describe("Requirement 4: Fail-Closed Behavior on Missing or Malformed Risk Answers", () => {
    it("fails closed to escalation when security_vulnerability_risk is missing", () => {
      const item = createMockItem({ title: "Harmless documentation fix" });
      const answers = createBenignAnswers();
      delete (answers as any).security_vulnerability_risk;

      const record = composeJevFirstDecisionRecord(item, answers, createMockProvenance());

      expect(record.scores.securityVulnerabilityProb).toBeNull();
      expect(record.routing.escalateToDeepReview).toBe(true);
      expect(record.routing.advisoryRoute).toBe("security_escalation");
      expect(
        record.routing.uncertaintyFlags.some(
          (f) => f.includes("missing_assessments") && f.includes("security_vulnerability_risk"),
        ),
      ).toBe(true);
      expect(
        record.routing.escalationReasons.some(
          (r) => r.includes("missing_mandatory_assessments") && r.includes("security_vulnerability_risk"),
        ),
      ).toBe(true);
    });

    it("fails closed to escalation when noul answer is malformed (out of range, NaN, non-numeric)", () => {
      const item = createMockItem();
      const answers = createBenignAnswers();
      (answers as any).privacy_or_pii_risk = { type: "noul", noul: 1.5 }; // invalid > 1

      const record = composeJevFirstDecisionRecord(item, answers, createMockProvenance());

      expect(record.scores.privacyOrPiiProb).toBeNull();
      expect(record.routing.escalateToDeepReview).toBe(true);
      expect(
        record.routing.uncertaintyFlags.some(
          (f) => f.includes("missing_assessments") && f.includes("privacy_or_pii_risk"),
        ),
      ).toBe(true);
    });

    it("tracks ambiguous noul uncertainty flags when probability is between 0.35 and 0.65", () => {
      const item = createMockItem();
      const answers = createBenignAnswers();
      (answers.security_vulnerability_risk as any).noul = 0.42;

      const record = composeJevFirstDecisionRecord(item, answers, createMockProvenance());

      expect(record.routing.uncertaintyFlags).toContain("ambiguous_noul:security_risk(0.42)");
    });
  });

  describe("Requirement 5: Cost Estimation & Credential Fingerprinting", () => {
    it("accurately computes $0.042 / 1M input tokens", () => {
      // 1,000,000 tokens -> $0.042
      expect(estimateJevInferenceCostUsd(1_000_000)).toBe(0.042);
      // 500,000 tokens -> $0.021
      expect(estimateJevInferenceCostUsd(500_000)).toBe(0.021);
      // 10,000 tokens -> $0.00042
      expect(estimateJevInferenceCostUsd(10_000)).toBe(0.00042);

      // Edge cases: 0, negative, NaN, null, undefined -> 0
      expect(estimateJevInferenceCostUsd(0)).toBe(0);
      expect(estimateJevInferenceCostUsd(-500)).toBe(0);
      expect(estimateJevInferenceCostUsd(NaN)).toBe(0);
      expect(estimateJevInferenceCostUsd(Infinity)).toBe(0);
      expect(estimateJevInferenceCostUsd(null)).toBe(0);
      expect(estimateJevInferenceCostUsd(undefined)).toBe(0);
    });

    it("computes 12-char hex credential fingerprint without leaking secret", () => {
      const secret = "typesafe_sk_live_99887766554433221100";
      const fp = computeCredentialFingerprint(secret);

      expect(fp).toHaveLength(12);
      expect(/^[0-9a-f]{12}$/.test(fp)).toBe(true);
      expect(fp).not.toContain("typesafe");
      expect(fp).not.toContain("99887766554433221100");

      // Trims whitespace and quotes deterministically
      expect(computeCredentialFingerprint(`  "${secret}"  `)).toBe(fp);
      expect(computeCredentialFingerprint(`  '${secret}'  `)).toBe(fp);
    });

    it("resolves API key from explicit options or environment variables", () => {
      expect(resolveTypeSafeApiKey({ explicitKey: "test-key-123" })).toBe("test-key-123");
      expect(resolveTypeSafeApiKey({ explicitKey: '  "quoted-key"  ' })).toBe("quoted-key");
    });
  });

  describe("Requirement 6: JevDecisionStore Persistence & Provenance", () => {
    it("persists, hydrates, and validates fresh decisions using SQLite :memory:", () => {
      const store = new JevDecisionStore(":memory:");

      try {
        const item = createMockItem({ number: 501, title: "Feature: Add GraphQL support" });
        const answers = createBenignAnswers();
        const provenance = createMockProvenance({
          model: "jev-1.14.0",
          decisionIdentity: "identity_501_v2",
          usage: { inputTokens: 2500, outputTokens: 0 },
        });

        const record = composeJevFirstDecisionRecord(item, answers, provenance);
        store.upsertDecision(record);

        // Check hasFreshDecision by matching decisionIdentity
        expect(store.hasFreshDecision("odysseus-dev/odysseus", "pr", 501, "identity_501_v2")).toBe(true);
        expect(store.hasFreshDecision("odysseus-dev/odysseus", "pr", 501, "different_stale_identity")).toBe(false);

        // Hydrate record and verify all deep properties
        const hydrated = store.getDecision("odysseus-dev/odysseus", "pr", 501);
        expect(hydrated).toBeDefined();
        expect(hydrated!.item.number).toBe(501);
        expect(hydrated!.item.type).toBe("pr");
        expect(hydrated!.item.title).toBe("Feature: Add GraphQL support");
        expect(hydrated!.classification.category).toBe("documentation");
        expect(hydrated!.provenance.decisionIdentity).toBe("identity_501_v2");
        expect(hydrated!.provenance.estimatedCostUsd).toBe(estimateJevInferenceCostUsd(2500));
        expect(hydrated!.scores.operationalPriorityRaw).toBe(0);
        expect(hydrated!.routing.advisory).toBe(true);

        // Check getAllDecisions
        const all = store.getAllDecisions("odysseus-dev/odysseus");
        expect(all).toHaveLength(1);
        expect(all[0].item.number).toBe(501);

        // Upsert update conflict handling
        const updatedRecord: JevFirstDecisionRecord = {
          ...record,
          classification: {
            ...record.classification,
            category: "feature",
          },
        };
        store.upsertDecision(updatedRecord);
        const reHydrated = store.getDecision("odysseus-dev/odysseus", "pr", 501);
        expect(reHydrated!.classification.category).toBe("feature");
      } finally {
        store.close();
      }
    });
  });

  describe("Requirement 7: Pilot Sampling & Study Comparison Analysis", () => {
    it("selects a deterministic stratified pilot sample with repaired items", () => {
      // Build dummy inventory
      const items: EnrichedEvaluationItem[] = [];

      // Repaired items
      for (const num of [6745, 605, 3604]) {
        items.push({
          prItem: createMockItem({ number: num }),
          fullBodyLength: 200,
          qwen: {
            repo: "odysseus-dev/odysseus",
            itemType: "pr",
            itemNumber: num,
            model: "qwen3-7b",
            sourceHash: "hash",
            category: "bug",
            priority: "high",
            complexity: "moderate",
            confidence: 0.9,
            needsDeepReview: false,
            riskFlags: [],
            reason: "repaired",
            escalate: false,
            escalationReason: "",
            uncertaintyFlags: [],
            fullBodyLen: 200,
            isInputTruncated: false,
            promptTokens: 1000,
            outputTokens: 50,
            elapsedSeconds: 1.2,
            classifiedAt: "2026-10-25T12:00:00Z",
          },
        });
      }

      // Security items
      for (let i = 1; i <= 20; i++) {
        items.push({
          prItem: createMockItem({ number: 1000 + i }),
          fullBodyLength: 300,
          qwen: {
            repo: "odysseus-dev/odysseus",
            itemType: "pr",
            itemNumber: 1000 + i,
            model: "qwen3-7b",
            sourceHash: "hash",
            category: "security",
            priority: "high",
            complexity: "complex",
            confidence: 0.85,
            needsDeepReview: true,
            riskFlags: ["security"],
            reason: "sec",
            escalate: true,
            escalationReason: "safety_gate:security",
            uncertaintyFlags: [],
            fullBodyLen: 300,
            isInputTruncated: false,
            promptTokens: 1100,
            outputTokens: 60,
            elapsedSeconds: 1.5,
            classifiedAt: "2026-10-25T12:00:00Z",
          },
        });
      }

      // Routine local items
      for (let i = 1; i <= 30; i++) {
        items.push({
          prItem: createMockItem({ number: 2000 + i, type: "issue" }),
          fullBodyLength: 150,
          qwen: {
            repo: "odysseus-dev/odysseus",
            itemType: "issue",
            itemNumber: 2000 + i,
            model: "qwen3-7b",
            sourceHash: "hash",
            category: "documentation",
            priority: "low",
            complexity: "simple",
            confidence: 0.95,
            needsDeepReview: false,
            riskFlags: [],
            reason: "doc",
            escalate: false,
            escalationReason: "",
            uncertaintyFlags: [],
            fullBodyLen: 150,
            isInputTruncated: false,
            promptTokens: 800,
            outputTokens: 40,
            elapsedSeconds: 0.9,
            classifiedAt: "2026-10-25T12:00:00Z",
          },
        });
      }

      const sample = selectStratifiedPilotSample(items, 25);
      expect(sample.length).toBeLessThanOrEqual(25);
      expect(sample.length).toBeGreaterThan(0);

      // Verify repaired items are prioritized
      const sampleNumbers = sample.map((s) => s.prItem.number);
      expect(sampleNumbers).toContain(6745);
      expect(sampleNumbers).toContain(605);
      expect(sampleNumbers).toContain(3604);
    });

    it("computes comprehensive comparative evaluation metrics against Qwen", () => {
      const qwenItem1: QwenClassificationRow = {
        repo: "odysseus-dev/odysseus",
        itemType: "pr",
        itemNumber: 1,
        model: "qwen3-7b",
        sourceHash: "h1",
        category: "security",
        priority: "high",
        complexity: "complex",
        confidence: 0.9,
        needsDeepReview: true,
        riskFlags: ["security"],
        reason: "auth risk",
        escalate: true,
        escalationReason: "safety_gate:security",
        uncertaintyFlags: [],
        fullBodyLen: 500,
        isInputTruncated: false,
        promptTokens: 1200,
        outputTokens: 100,
        elapsedSeconds: 2.5,
        classifiedAt: "2026-10-26T10:00:00Z",
      };

      const qwenItem2: QwenClassificationRow = {
        repo: "odysseus-dev/odysseus",
        itemType: "issue",
        itemNumber: 2,
        model: "qwen3-7b",
        sourceHash: "h2",
        category: "bug",
        priority: "medium",
        complexity: "moderate",
        confidence: 0.8,
        needsDeepReview: false,
        riskFlags: [],
        reason: "minor bug",
        escalate: false,
        escalationReason: "",
        uncertaintyFlags: [],
        fullBodyLen: 300,
        isInputTruncated: false,
        promptTokens: 900,
        outputTokens: 50,
        elapsedSeconds: 1.5,
        classifiedAt: "2026-10-26T10:00:00Z",
      };

      const evalItems: EnrichedEvaluationItem[] = [
        { prItem: createMockItem({ number: 1, type: "pr" }), fullBodyLength: 500, qwen: qwenItem1 },
        { prItem: createMockItem({ number: 2, type: "issue" }), fullBodyLength: 300, qwen: qwenItem2 },
      ];

      // Jev Decision Records
      const answers1 = createBenignAnswers();
      (answers1.category as any).choice = "security";
      (answers1.operational_priority as any).score = 2; // high
      (answers1.change_complexity as any).score = 2; // complex
      (answers1.security_vulnerability_risk as any).noul = 0.85;

      const answers2 = createBenignAnswers();
      (answers2.category as any).choice = "bug";
      (answers2.operational_priority as any).score = 1; // medium
      (answers2.change_complexity as any).score = 1; // moderate

      const jevRecords: JevFirstDecisionRecord[] = [
        composeJevFirstDecisionRecord(evalItems[0].prItem, answers1, createMockProvenance({ latencyMs: 250 })),
        composeJevFirstDecisionRecord(evalItems[1].prItem, answers2, createMockProvenance({ latencyMs: 150 })),
      ];

      const metrics = compareJevAgainstQwen(evalItems, jevRecords);

      expect(metrics.totalCompared).toBe(2);
      expect(metrics.categoryExactMatchRate).toBe(1.0);
      expect(metrics.priorityExactMatchRate).toBe(1.0);
      expect(metrics.priorityWithinOneTierRate).toBe(1.0);
      expect(metrics.complexityExactMatchRate).toBe(1.0);
      expect(metrics.routingAgreementRate).toBe(1.0);

      // Routing confusion matrix
      expect(metrics.routingConfusion.bothEscalate).toBe(1);
      expect(metrics.routingConfusion.bothLocalOnly).toBe(1);
      expect(metrics.routingConfusion.jevOnlyEscalate).toBe(0);
      expect(metrics.routingConfusion.qwenOnlyEscalate).toBe(0);

      // Latency and cost
      expect(metrics.performance.jevMeanLatencyMs).toBe(200);
      expect(metrics.performance.speedupFactor).toBeGreaterThan(1);
      expect(metrics.performance.jevTotalCostUsd).toBeGreaterThan(0);

      // Safety analysis
      expect(metrics.safetyAnalysis.qwenSecurityOrDataLossCount).toBe(1);
      expect(metrics.safetyAnalysis.jevSystemPostGateEscalatedCount).toBe(1);
      expect(metrics.safetyAnalysis.unmitigatedHighRiskFalseNegatives).toHaveLength(0);

      // Calibration buckets
      expect(metrics.calibrationBuckets.length).toBeGreaterThan(0);
    });
  });
});
