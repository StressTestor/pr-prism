import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDuplicateClusters } from "../cluster.js";
import { JevDecisionStore } from "../decisions/decision-store.js";
import { MockDecisionProvider } from "../decisions/mock-provider.js";
import { evaluateJevFirstItem } from "../decisions/triage-v2.js";
import {
  computeIssueInputFingerprint,
  computePRInputFingerprint,
  DEEP_REVIEW_PROMPT_VERSION,
} from "../deep-reviewer.js";
import { buildClosureCandidateRecord, exportClosureCandidates } from "../housekeeping/closure-verification.js";
import { calibrateItem } from "../housekeeping/priority-calibration.js";
import { discoverRelationshipCandidates } from "../housekeeping/relationship-discovery.js";
import { buildTriagePlan, type TriagePlanInputEntry } from "../housekeeping/triage-plan.js";
import { generateChangeRequest, generateMissingInfoRequest } from "../maintainer/drafts.js";
import { MockMaintainerTransport } from "../maintainer/mock-transport.js";
import { MaintainerActionPipeline } from "../maintainer/pipeline.js";
import { buildWorklist } from "../maintainer/worklist.js";
import { DurableReviewQueue, type ReviewPriorityBand } from "../review-queue.js";
import { VectorStore } from "../store.js";
import type { Cluster, PRItem, StoreItem } from "../types.js";

describe("PR-Prism v4 End-to-End Operational Integration", () => {
  let tempDir: string;
  let dbPath: string;
  let decisionsDbPath: string;
  let queueDbPath: string;
  let store: VectorStore;
  let jevStore: JevDecisionStore;
  let reviewQueue: DurableReviewQueue;
  const repo = "odysseus-dev/odysseus";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prism-v4-e2e-"));
    dbPath = join(tempDir, "prism.db");
    decisionsDbPath = join(tempDir, "decisions.db");
    queueDbPath = join(tempDir, "review-queue.sqlite");

    store = new VectorStore(dbPath, 4, "mock-embedder");
    jevStore = new JevDecisionStore(decisionsDbPath);
    reviewQueue = new DurableReviewQueue(queueDbPath);
  });

  afterEach(() => {
    store.close();
    jevStore.close();
    reviewQueue.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeItem(overrides: Partial<StoreItem> = {}): StoreItem {
    return {
      id: `${repo}#${overrides.number || 101}`,
      type: overrides.type || "pr",
      number: overrides.number || 101,
      repo,
      title: overrides.title || "Fix memory leak in network pool",
      bodySnippet: overrides.bodySnippet || "Resolves issue with connection leak under heavy traffic.",
      embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      metadata: {
        state: "open",
        author: "alice",
        labels: ["bug", "networking"],
        comments: 2,
        reactions: 1,
        assignees: [],
        isDraft: false,
        headRefOid: "commit-aaa-111",
        ...(overrides.metadata || {}),
      },
      createdAt: overrides.createdAt || "2026-10-01T10:00:00Z",
      updatedAt: overrides.updatedAt || "2026-10-01T12:00:00Z",
    };
  }

  function storeItemToPRItem(item: StoreItem): PRItem {
    const meta = (item.metadata || {}) as Record<string, unknown>;
    return {
      number: item.number,
      title: item.title,
      body: item.bodySnippet,
      state: typeof meta.state === "string" ? meta.state : "open",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: typeof meta.author === "string" ? meta.author : "unknown",
      labels: Array.isArray(meta.labels) ? (meta.labels as string[]) : [],
      headRefOid: typeof meta.headRefOid === "string" ? meta.headRefOid : undefined,
      repo: item.repo,
      type: item.type as "pr" | "issue",
      closesIssues: Array.isArray(meta.closesIssues) ? (meta.closesIssues as number[]) : undefined,
    };
  }

  it("completes full 9-stage operational data flow for a synthetic Pull Request", async () => {
    // ── STAGE 1 & 2: Ingestion into VectorStore ────────────────────────────
    const prStoreItem = makeItem({
      number: 501,
      type: "pr",
      title: "Optimize buffer allocation in streaming parser",
      bodySnippet: "Refactors slice handling to eliminate redundant allocations during large payload ingestion.",
      metadata: {
        state: "open",
        author: "charlie",
        labels: ["performance", "core"],
        headRefOid: "commit-501-abc",
      },
      createdAt: "2026-10-10T10:00:00Z",
      updatedAt: "2026-10-10T11:00:00Z",
    });

    store.upsert(prStoreItem);
    const storedItems = store.getAllItems(repo);
    expect(storedItems.length).toBe(1);
    expect(storedItems[0].number).toBe(501);

    const prItem = storeItemToPRItem(prStoreItem);

    // ── STAGE 3: Jev Decision Evaluation ──────────────────────────────────
    const mockProvider = new MockDecisionProvider({
      model: "jev-1.14.0",
      presetAnswers: {
        category: {
          type: "choice",
          choice: "performance",
          confidence: 0.92,
          probabilities: { performance: 0.92, bug: 0.08 },
        },
      },
    });

    const jevDecision = await evaluateJevFirstItem(prItem, mockProvider, {
      model: "jev-1.14.0",
    });

    expect(jevDecision.classification.category).toBe("performance");
    expect(jevDecision.classification.categoryConfidence).toBeGreaterThanOrEqual(0.8);
    expect(jevDecision.provenance.inputHash).toBeDefined();

    jevStore.upsertDecision(jevDecision);
    const savedDecision = jevStore.getDecision(repo, "pr", 501);
    expect(savedDecision).toBeDefined();
    expect(savedDecision?.item.number).toBe(501);

    // ── STAGE 4: Relationship Discovery ───────────────────────────────────
    const clusters: Cluster[] = findDuplicateClusters(store, [prItem], {
      threshold: 0.85,
      repo,
    });

    const relResult = discoverRelationshipCandidates([prItem], clusters, { repo });
    expect(relResult.candidateCount).toBe(0); // Isolated item has 0 duplicates

    // ── STAGE 5: Closure Verification ─────────────────────────────────────
    // Single non-duplicate item is not a closure candidate
    const closureExport = exportClosureCandidates([], repo);
    expect(closureExport.verifiedCandidates).toBe(0);

    // ── STAGE 6: Priority Calibration (P0 Negative Controls) ──────────────
    const calibrated = calibrateItem(
      prItem,
      jevDecision.derived.priorityTier,
      jevDecision.routing.escalationReasons,
      jevDecision as any,
    );
    expect(calibrated.calibratedBand).toBeDefined();
    expect(calibrated.dimensions.isRoutineDocsOrTests).toBe(false);

    // ── STAGE 7: Triage Plan & Review Routing Schedule ────────────────────
    const triageEntry: TriagePlanInputEntry = {
      item: prItem,
      actionSignal: "INTERMEDIATE_REVIEW",
      actionReasons: ["Performance critical change in parser core"],
      calibratedBand: calibrated.calibratedBand,
    };

    const triagePlan = buildTriagePlan([triageEntry], repo);
    expect(triagePlan.summary.totalItems).toBe(1);
    expect(triagePlan.summary.totalPRs).toBe(1);
    expect(triagePlan.summary.intermediateReviews).toBe(1);

    // Seed into review queue
    const fingerprint = computePRInputFingerprint({
      repo: prItem.repo,
      number: prItem.number,
      title: prItem.title,
      body: prItem.body,
    });

    const jobId = `${repo}:pr:501`;
    reviewQueue.enqueueJob({
      jobId,
      repo,
      itemType: "pr",
      itemNumber: 501,
      title: prItem.title,
      priorityBand: "P2_MODERATE",
      priorityScore: 2500,
      inputFingerprint: fingerprint,
      promptSchemaVersion: DEEP_REVIEW_PROMPT_VERSION,
      payload: { tier: "intermediate", actionGroup: "INTERMEDIATE_REVIEW" },
    });

    expect(reviewQueue.getJob(jobId)).toBeDefined();
    expect(reviewQueue.getJob(jobId)?.status).toBe("queued");

    // ── STAGE 8: Tiered Review Execution & Checkpoint ─────────────────────
    // Complete review with strict schema output
    const validPRReviewResult = {
      summary: "Clean optimization eliminating buffer re-allocation.",
      findings: [
        {
          file: "src/streaming.ts",
          line: 42,
          severity: "low",
          category: "style",
          message: "Consider adding benchmark regression assertion.",
        },
      ],
      concerns: ["Potential edge case on empty buffer payload."],
      recommendation: "merge",
      confidence: 0.94,
    };

    reviewQueue.completeJobWithCheckpoint({
      jobId,
      leaseId: "lease-1",
      accountId: "acct-featherless-1",
      keyFingerprint: "fp-test-key-123",
      provider: "featherless",
      model: "zai-org/GLM-4.7-Flash",
      result: validPRReviewResult,
      promptTokens: 1200,
      completionTokens: 350,
      latencyMs: 820,
    });

    const checkpoint = reviewQueue.getLatestValidCheckpoint(repo, 501);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.checkpoint_status).toBe("completed");

    // ── STAGE 9: Maintainer Workbench & Action Preparation ────────────────
    const worklist = buildWorklist({
      store,
      repo,
      clusters: [],
      jevStore,
      queue: reviewQueue,
    });

    expect(worklist.total).toBe(1);
    const maintainerItem = worklist.items[0];
    expect(maintainerItem.number).toBe(501);
    expect(maintainerItem.hasDeepReview).toBe(true);
    expect(maintainerItem.reviewRecommendation).toBe("merge");
    expect(maintainerItem.category).toBe("performance");

    // Prepare draft action
    const draftComment = generateChangeRequest({
      repo,
      number: maintainerItem.number,
      title: maintainerItem.title,
      findings: [
        {
          severity: "low",
          description: "Consider adding benchmark regression assertion",
          fileOrSymbol: "src/streaming.ts",
        },
      ],
      reviewerNote: "Please add buffer edge-case test.",
    });
    expect(draftComment.body).toContain("Review and edit before submitting");

    // Pass through 9-checkpoint MaintainerActionPipeline
    const transport = new MockMaintainerTransport({ isDryRun: true });
    transport.setMockState({
      number: 501,
      state: "open",
      updatedAt: prItem.updatedAt,
    });

    const pipeline = new MaintainerActionPipeline(transport as any);
    const prepared = pipeline.prepare({
      kind: "request_changes",
      target: {
        repo,
        number: 501,
        type: "pr",
        currentState: "open",
        updatedAt: prItem.updatedAt,
      },
      draftSource: "template",
      proposedBody: draftComment.body,
      requiresWrite: true,
    });

    // Checkpoints 1 through 9
    let currentPrepared = prepared;
    for (let step = 1; step <= 9; step++) {
      currentPrepared = pipeline.verifyCheckpoint(currentPrepared, step);
    }

    // Execute in dry-run mode (default)
    const result = await pipeline.execute(currentPrepared);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.auditRecord.result).toBe("dry_run");
    expect(transport.calls.some((c) => c.method === "postComment")).toBe(false); // Zero live writes!
  });

  it("completes full 9-stage operational data flow for a synthetic Issue", async () => {
    // ── STAGE 1 & 2: Ingestion ────────────────────────────────────────────
    const issueStoreItem = makeItem({
      number: 102,
      type: "issue",
      title: "Connection reset by peer during WebSocket handshake under TLS 1.3",
      bodySnippet: "Steps to reproduce: initiate 50 concurrent TLS handshakes. Observed error: ECONNRESET.",
      metadata: {
        state: "open",
        author: "dave",
        labels: ["bug", "networking", "tls"],
      },
      createdAt: "2026-10-12T08:00:00Z",
      updatedAt: "2026-10-12T09:00:00Z",
    });

    store.upsert(issueStoreItem);
    const issueItem = storeItemToPRItem(issueStoreItem);

    // ── STAGE 3: Jev Decision Evaluation ──────────────────────────────────
    const mockProvider = new MockDecisionProvider({
      model: "jev-1.14.0",
      presetAnswers: {
        category: {
          type: "choice",
          choice: "bug",
          confidence: 0.96,
          probabilities: { bug: 0.96, question: 0.04 },
        },
      },
    });

    const jevDecision = await evaluateJevFirstItem(issueItem, mockProvider);
    expect(jevDecision.classification.category).toBe("bug");
    jevStore.upsertDecision(jevDecision);

    // ── STAGE 4-7: Housekeeping & Triage Plan ─────────────────────────────
    const calibrated = calibrateItem(
      issueItem,
      jevDecision.derived.priorityTier,
      jevDecision.routing.escalationReasons,
      jevDecision as any,
    );

    const triagePlan = buildTriagePlan(
      [
        {
          item: issueItem,
          actionSignal: "INTERMEDIATE_REVIEW",
          actionReasons: ["Reproducible network defect with TLS impact"],
          calibratedBand: calibrated.calibratedBand,
        },
      ],
      repo,
    );

    expect(triagePlan.summary.totalIssues).toBe(1);
    expect(triagePlan.summary.intermediateReviews).toBe(1);

    // ── STAGE 8: Dedicated Issue Review Checkpoint ────────────────────────
    const fingerprint = computeIssueInputFingerprint({
      repo,
      number: 102,
      title: issueItem.title,
      body: issueItem.body,
      author: issueItem.author,
    });

    const validIssueReviewResult = {
      summary: "Valid network handshake bug reproducible under concurrency.",
      issueAction: "confirm_bug",
      validityAssessment: "valid_bug",
      confidence: 0.91,
      suggestedNextSteps: ["Add concurrent handshake regression test", "Check TLS cipher session reuse"],
    };

    const reviewBand: ReviewPriorityBand = calibrated.calibratedBand.startsWith("P0")
      ? "P0_CRITICAL"
      : calibrated.calibratedBand.startsWith("P1")
        ? "P1_HIGH"
        : calibrated.calibratedBand.startsWith("P2")
          ? "P2_MODERATE"
          : "P3_ROUTINE_LOCAL";

    const jobId = `${repo}:issue:102`;
    reviewQueue.enqueueJob({
      jobId,
      repo,
      itemType: "issue",
      itemNumber: 102,
      title: issueItem.title,
      priorityBand: reviewBand,
      priorityScore: 2400,
      inputFingerprint: fingerprint,
      promptSchemaVersion: DEEP_REVIEW_PROMPT_VERSION,
      payload: { tier: "intermediate", actionGroup: "INTERMEDIATE_REVIEW" },
    });

    reviewQueue.completeJobWithCheckpoint({
      jobId,
      leaseId: "lease-2",
      accountId: "acct-featherless-1",
      keyFingerprint: "fp-test-key-123",
      provider: "featherless",
      model: "zai-org/GLM-4.7-Flash",
      result: validIssueReviewResult,
      promptTokens: 800,
      completionTokens: 220,
      latencyMs: 650,
    });

    // ── STAGE 9: Maintainer Workbench & Drafting ──────────────────────────
    const worklist = buildWorklist({
      store,
      repo,
      clusters: [],
      jevStore,
      queue: reviewQueue,
      filter: { type: "issue" },
    });

    expect(worklist.total).toBe(1);
    const maintainerItem = worklist.items[0];
    expect(maintainerItem.type).toBe("issue");
    expect(maintainerItem.hasDeepReview).toBe(true);

    const draft = generateMissingInfoRequest({
      repo,
      number: maintainerItem.number,
      title: maintainerItem.title,
      type: "issue",
      missingItems: ["Minimal reproduction repo or curl command"],
    });
    expect(draft.body).toContain("Review and edit before submitting");
  });

  it("negative test: unverified duplicate candidate CANNOT become a verified closure", async () => {
    // Source item: open PR with NO headRefOid match, NO closing edge, low similarity
    const sourceItem = storeItemToPRItem(
      makeItem({
        number: 301,
        type: "pr",
        title: "Improve database query latency",
        bodySnippet: "Tweaks pool sizing.",
        metadata: { state: "open", headRefOid: "commit-source-999" },
      }),
    );

    // Target item: open PR (not merged!)
    const targetItem = storeItemToPRItem(
      makeItem({
        number: 205,
        type: "pr",
        title: "Database connection tuning",
        bodySnippet: "Adjusts pool timeout values.",
        metadata: { state: "open", headRefOid: "commit-target-888" },
      }),
    );

    // Attempt closure verification with unverified/insufficient evidence:
    // - similarity is 0.74 (weak, below strong threshold 0.85)
    // - target is NOT merged (state: open)
    // - closing edge is NOT confirmed
    // - Jev duplicate candidate noul is 0.45 (< 0.80)
    const closureRecord = buildClosureCandidateRecord(sourceItem, targetItem, {
      embeddingSimilarity: 0.74,
      closingEdgeConfirmed: false,
      jevDecision: {
        duplicateCandidateNoul: 0.45,
        alreadyResolvedNoul: 0.2,
      },
    });

    // 1. Must NOT be verified
    expect(closureRecord.closureVerified).toBe(false);

    // 2. Must require maintainer approval
    expect(closureRecord.requiresManualVerification).toBe(true);
    expect(closureRecord.pendingMaintainerApproval).toBe(true);

    // 3. Must specify discrete missing evidence reasons
    expect(closureRecord.missingEvidence.length).toBeGreaterThan(0);
    expect(closureRecord.missingEvidence.some((m) => m.includes("merged or closed"))).toBe(true);
    expect(closureRecord.missingEvidence.some((m) => m.includes("Explicit closing keyword"))).toBe(true);

    // 4. In TriagePlan, unverified closure candidate is NOT counted as avoided call
    const triagePlan = buildTriagePlan(
      [
        {
          item: sourceItem,
          actionSignal: "CLOSE_CANDIDATE",
          actionReasons: ["Similarity only"],
          calibratedBand: "P3_CLOSURE_CANDIDATE",
          closureCandidateVerified: false, // NOT verified!
        },
      ],
      repo,
    );

    expect(triagePlan.summary.estimatedReviewCallsAvoided).toBe(0); // Strictly ZERO

    // 5. In ActionPipeline, attempting to execute closure without verified checkpoints is blocked
    const transport = new MockMaintainerTransport({ isDryRun: true });
    const pipeline = new MaintainerActionPipeline(transport as any);
    const preparedAction = pipeline.prepare({
      kind: "close_item",
      target: {
        repo,
        number: 301,
        type: "pr",
        currentState: "open",
        updatedAt: sourceItem.updatedAt,
      },
      draftSource: "template",
      requiresWrite: true,
    });

    // Execute without verifying all 9 checkpoints
    const executeResult = await pipeline.execute(preparedAction);
    expect(executeResult.success).toBe(false);
    expect(executeResult.auditRecord.result).toBe("blocked");
    expect(executeResult.error).toContain("blocked by unmet checkpoints");
    expect(transport.calls.some((c) => c.method === "closeItem")).toBe(false); // Zero GitHub close calls
  });

  it("verifies read-only queries preserve disposable baseline and source sentinels", () => {
    const baseline = join(tempDir, "baseline.sqlite");
    const sentinel = join(tempDir, "source-sentinel");
    const fixture = new Database(baseline);
    fixture.exec("CREATE TABLE fixture(x TEXT); INSERT INTO fixture VALUES('fake evidence')");
    fixture.close();
    writeFileSync(sentinel, "source untouched");
    const original = readFileSync(baseline);
    const reader = new Database(baseline, { readonly: true, fileMustExist: true });
    try {
      expect(reader.prepare("SELECT x FROM fixture").get()).toEqual({ x: "fake evidence" });
      expect(() => reader.prepare("DELETE FROM fixture").run()).toThrow();
    } finally {
      reader.close();
    }
    expect(readFileSync(baseline)).toEqual(original);
    expect(readFileSync(sentinel, "utf8")).toBe("source untouched");
  });
});
