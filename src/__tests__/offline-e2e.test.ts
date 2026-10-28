import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selectCanonical } from "../canonical.js";
import { generateMarkdownReport } from "../cli/formatting/report.js";
import { findDuplicateClusters } from "../cluster.js";
import { confidenceTier } from "../confidence.js";
import { DEFAULT_SCORING_WEIGHTS, type PrismConfig } from "../config.js";
import {
  createDecisionProvider,
  DisabledDecisionProvider,
  evaluateItemDecisions,
  MockDecisionProvider,
  TRIAGE_SCHEMA_VERSION,
} from "../decisions/index.js";
import { normalizeGraphQLIssue, normalizeGraphQLPR, normalizeRestIssue, normalizeRestPR } from "../github/index.js";
import { GitHubClient } from "../github.js";
import { itemMetadata } from "../metadata.js";
import { buildScorerContext, rankPRs } from "../scorer.js";
import { cosineSimilarity } from "../similarity.js";
import { VectorStore } from "../store.js";
import type { EmbeddingProvider, PRItem, StoreItem } from "../types.js";
import { checkVisionAlignment } from "../vision.js";
import { createWriteGate } from "../write-gate.js";
import { captureProcessEnv, getIsolatedEnv, restoreProcessEnv } from "./cli-test-env.js";

describe("PR-Prism v4 Offline End-to-End Pipeline & Integration Readiness", () => {
  let tempDir: string;
  let dbPath: string;
  let visionDocPath: string;
  let baselineEnv: NodeJS.ProcessEnv;
  let networkAttemptCount = 0;
  let originalHttpRequest: typeof http.request;
  let originalHttpsRequest: typeof https.request;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    // 1. Strict credential isolation
    baselineEnv = captureProcessEnv();
    const isolatedEnv = getIsolatedEnv();
    for (const key of Object.keys(process.env)) {
      if (!(key in isolatedEnv)) {
        delete process.env[key];
      }
    }

    // 2. Strict network isolation: intercept all HTTP/HTTPS and fetch calls
    networkAttemptCount = 0;
    originalHttpRequest = http.request;
    originalHttpsRequest = https.request;
    originalFetch = globalThis.fetch;

    const blockNetwork = (protocol: string) => {
      networkAttemptCount++;
      throw new Error(`CRITICAL VIOLATION: Offline E2E harness blocked unauthorized external ${protocol} call`);
    };

    http.request = ((..._args: any[]) => blockNetwork("http.request")) as any;
    https.request = ((..._args: any[]) => blockNetwork("https.request")) as any;
    globalThis.fetch = (async (..._args: any[]) => blockNetwork("globalThis.fetch")) as any;

    // 3. Isolated filesystem setup
    tempDir = mkdtempSync(join(tmpdir(), "prism-v4-e2e-"));
    dbPath = join(tempDir, "prism-e2e.db");
    visionDocPath = join(tempDir, "VISION.md");

    // Synthetic vision document
    writeFileSync(
      visionDocPath,
      `# PR-Prism Architecture Vision

## Core Capabilities
PR-Prism provides high-throughput GitHub PR and issue triage, deterministic duplicate detection,
incident-aware scoring, and optional advisory typed decisions.

## Out of Scope
Hosting git repositories or replacing interactive human code reviews.
`,
      "utf-8",
    );
  });

  afterAll(() => {
    // Restore environment, network, and temporary files
    restoreProcessEnv(baselineEnv);
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    globalThis.fetch = originalFetch;

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("completes the full triage workflow offline with zero mutations and zero network requests", async () => {
    const repoFull = "test-owner/test-repo";
    const [owner, repo] = repoFull.split("/");

    // ── STAGE 5.1: SYNTHETIC GITHUB INGESTION & NORMALIZATION ─────────
    // Synthetic GraphQL Pull Request (high quality, has tests, CI passing, approved)
    const rawGraphQLPR1 = {
      number: 101,
      title: "Fix retry backoff timeout in network client",
      body: "Implements incremental backoff retry when rate limit reset is approaching.\nFixes #50",
      author: { login: "contributor-alice" },
      state: "OPEN",
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-02T12:00:00Z",
      additions: 45,
      deletions: 10,
      changedFiles: 2,
      id: "PR_node_101",
      headRefOid: "commit_sha_101",
      url: "https://github.com/test-owner/test-repo/pull/101",
      labels: { nodes: [{ name: "bug" }, { name: "networking" }] },
      files: {
        nodes: [
          { path: "src/net/retry.ts" },
          { path: "src/__tests__/retry.test.ts" }, // qualifies hasTests = true
        ],
      },
      reviews: {
        totalCount: 2,
        nodes: [{ state: "APPROVED" }, { state: "APPROVED" }],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
              },
            },
          },
        ],
      },
      closingIssuesReferences: {
        nodes: [{ number: 50, repository: { nameWithOwner: repoFull } }],
      },
    };

    // Synthetic GraphQL Pull Request (duplicate of PR 101, but lower quality: no tests, pending CI)
    const rawGraphQLPR2 = {
      number: 102,
      title: "Fix retry backoff timeout in network client",
      body: "Duplicate submission of retry backoff logic without test coverage.\nCloses #50",
      author: { login: "contributor-bob" },
      state: "OPEN",
      createdAt: "2026-08-01T11:00:00Z",
      updatedAt: "2026-08-01T11:30:00Z",
      additions: 120,
      deletions: 5,
      changedFiles: 1,
      id: "PR_node_102",
      headRefOid: "commit_sha_102",
      url: "https://github.com/test-owner/test-repo/pull/102",
      labels: { nodes: [{ name: "bug" }] },
      files: {
        nodes: [{ path: "src/net/retry.ts" }],
      },
      reviews: {
        totalCount: 0,
        nodes: [],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "PENDING",
              },
            },
          },
        ],
      },
      closingIssuesReferences: {
        nodes: [{ number: 50, repository: { nameWithOwner: repoFull } }],
      },
    };

    // Synthetic GraphQL Issue (the original bug report #50)
    const rawGraphQLIssue = {
      number: 50,
      title: "Connection retries fail with timeout under high load",
      body: "When API rate limits are approached, retry requests immediately timeout rather than backing off.",
      author: { login: "user-reporter" },
      state: "OPEN",
      createdAt: "2026-07-28T09:00:00Z",
      updatedAt: "2026-07-29T14:00:00Z",
      id: "ISSUE_node_50",
      url: "https://github.com/test-owner/test-repo/issues/50",
      labels: { nodes: [{ name: "bug" }] },
    };

    // Synthetic REST PR (distinct vision-aligned feature: architecture docs)
    const rawRestPR = {
      number: 201,
      title: "Add architecture vision documentation and triage guide",
      body: "Documents PR-Prism architecture vision, core capabilities, and triage guidelines.",
      user: { login: "maintainer-charlie" },
      state: "open",
      created_at: "2026-08-03T08:00:00Z",
      updated_at: "2026-08-03T08:30:00Z",
      node_id: "PR_node_201",
      html_url: "https://github.com/test-owner/test-repo/pull/201",
      diff_url: "https://github.com/test-owner/test-repo/pull/201.diff",
      labels: [{ name: "documentation" }],
    };

    // Synthetic REST Issue
    const rawRestIssue = {
      number: 202,
      title: "Question: roadmap for multi-repo clustering support",
      body: "Inquiring about multi-repo duplicate clustering roadmap.",
      user: { login: "user-curious" },
      state: "open",
      created_at: "2026-08-03T09:00:00Z",
      updated_at: "2026-08-03T09:15:00Z",
      node_id: "ISSUE_node_202",
      html_url: "https://github.com/test-owner/test-repo/issues/202",
      labels: [{ name: "question" }],
    };

    // Run modular normalization functions
    const normPR1 = normalizeGraphQLPR(rawGraphQLPR1, repoFull);
    const normPR2 = normalizeGraphQLPR(rawGraphQLPR2, repoFull);
    const normIssue50 = normalizeGraphQLIssue(rawGraphQLIssue, repoFull);
    const normPR201 = normalizeRestPR(rawRestPR, repoFull);
    const normIssue202 = normalizeRestIssue(rawRestIssue, repoFull);

    expect(normPR1.hasTests).toBe(true);
    expect(normPR1.ciStatus).toBe("success");
    expect(normPR1.reviewCount).toBe(2);
    expect(normPR1.closesIssues).toEqual([50]);

    expect(normPR2.hasTests).toBe(false);
    expect(normPR2.ciStatus).toBe("pending");
    expect(normPR2.reviewCount).toBe(0);

    expect(normIssue50.type).toBe("issue");
    expect(normPR201.type).toBe("pr");
    expect(normIssue202.type).toBe("issue");

    const allItems: PRItem[] = [normPR1, normPR2, normIssue50, normPR201, normIssue202];

    // ── STAGE 5.2: PERSISTENCE IN DISPOSABLE SQLITE DATABASE ──────────
    const embeddingDimensions = 4;
    const embeddingModel = "deterministic-unit-vectors-v1";
    const store = new VectorStore(dbPath, embeddingDimensions, embeddingModel);

    // ── STAGE 5.3: DETERMINISTIC VECTOR EMBEDDINGS ───────────────────
    // Generate unit vectors (L2 norm = 1.0)
    // PR 101 and PR 102 are semantically near-identical (similarity > 0.95)
    // Issue 50 is close to PR 101 & 102 (similarity > 0.90)
    // PR 201 is orthogonal (documentation feature, similarity near 0.0)
    // Issue 202 is orthogonal (general question)
    const v101 = new Float32Array([0.96, 0.28, 0.0, 0.0]); // norm = 0.96^2 + 0.28^2 = 0.9216 + 0.0784 = 1.0
    const v102 = new Float32Array([0.98, 0.198997, 0.0, 0.0]); // norm ≈ 1.0
    const v50 = new Float32Array([0.94, 0.341174, 0.0, 0.0]); // norm ≈ 1.0
    const v201 = new Float32Array([0.0, 0.0, 0.8, 0.6]); // norm = 0.64 + 0.36 = 1.0 (orthogonal)
    const v202 = new Float32Array([0.0, 0.0, 0.0, 1.0]); // norm = 1.0 (orthogonal)

    const embeddingsMap: Record<number, Float32Array> = {
      101: v101,
      102: v102,
      50: v50,
      201: v201,
      202: v202,
    };

    try {
      for (const item of allItems) {
        const storeItem: StoreItem = {
          id: `${repoFull}:${item.type}:${item.number}`,
          type: item.type,
          number: item.number,
          repo: repoFull,
          title: item.title,
          bodySnippet: item.body.slice(0, 500),
          embedding: embeddingsMap[item.number],
          metadata: itemMetadata(item),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
        store.upsert(storeItem);
      }

      const stats = store.getStats(repoFull);
      expect(stats.totalItems).toBe(5);
      expect(stats.prs).toBe(3);
      expect(stats.issues).toBe(2);

      // Verify retrieval fidelity
      const retrievedPR1 = store.getByNumber(repoFull, 101);
      expect(retrievedPR1).toBeDefined();
      expect(retrievedPR1?.title).toBe(normPR1.title);
      expect(retrievedPR1?.metadata.ciStatus).toBe("success");

      // Verify exact cosine similarity calculation
      const sim101_102 = cosineSimilarity(Array.from(v101), Array.from(v102));
      const sim101_201 = cosineSimilarity(Array.from(v101), Array.from(v201));
      expect(sim101_102).toBeGreaterThan(0.95);
      expect(sim101_201).toBeCloseTo(0.0, 4);

      // ── STAGE 5.4: SIMILARITY CLUSTERING & CANONICAL SELECTION ────────
      const clusters = findDuplicateClusters(store, allItems, {
        threshold: 0.85,
        repo: repoFull,
        includeBotAuthors: false,
        botAuthors: new Set(),
      });

      // One cluster containing #101, #102, #50
      expect(clusters).toHaveLength(1);
      const cluster = clusters[0];
      expect(cluster.items).toHaveLength(3);
      expect(cluster.avgSimilarity).toBeGreaterThan(0.85);

      // Confidence tier
      const tier = confidenceTier(cluster.minSimilarity);
      expect(["high", "solid"]).toContain(tier);

      // Canonical selection: PR 101 must be chosen over PR 102 and Issue 50
      // because PR 101 has tests (hasTests=true), passing CI, and review approvals
      const canonical = selectCanonical(cluster.items);
      expect(canonical.number).toBe(101);
      expect(canonical.author).toBe("contributor-alice");

      // ── STAGE 5.5: RANKING PIPELINE ──────────────────────────────────
      const config: PrismConfig = {
        version: 1,
        repo: repoFull,
        thresholds: {
          duplicate_similarity: 0.85,
          aligned: 0.65,
          drifting: 0.4,
        },
        scoring: {
          weights: DEFAULT_SCORING_WEIGHTS,
        },
        labels: {
          duplicate: "prism:duplicate",
          aligned: "prism:aligned",
          drifting: "prism:drifting",
          off_vision: "prism:off-vision",
          top_pick: "prism:top-pick",
        },
        decisions: {
          enabled: false,
          provider: "mock",
          model: "jev-1.14.0",
          timeout_ms: 10000,
        },
        cluster: {
          include_bot_authors: false,
          bot_authors: [],
        },
        batch_size: 50,
        max_prs: 5000,
      };

      // Create dry-run write-gated client with mocked octokit transport
      const writeGate = createWriteGate("dry-run");
      const client = new GitHubClient("mock-token", owner, repo, writeGate);

      const octokitMock = {
        issues: {
          getLabel: vi.fn(async () => {
            const err = new Error("Not Found") as any;
            err.status = 404;
            throw err;
          }),
          createLabel: vi.fn(async () => ({})),
          addLabels: vi.fn(async () => ({})),
          removeLabel: vi.fn(async () => ({})),
        },
      };
      (client as unknown as { octokit: unknown }).octokit = octokitMock;

      // Mock client methods needed for scoring context
      vi.spyOn(client, "getAuthorMergeCountGraphQL").mockImplementation(async (auth: string) => {
        if (auth === "contributor-alice") return 15;
        if (auth === "contributor-bob") return 1;
        return 0;
      });
      vi.spyOn(client, "getAuthorMergeCount").mockImplementation(async (auth: string) => {
        if (auth === "contributor-alice") return 15;
        if (auth === "contributor-bob") return 1;
        return 0;
      });

      const scorerContext = await buildScorerContext(allItems, client, store, repoFull);
      const ranked = rankPRs(allItems, config, scorerContext);

      expect(ranked.length).toBeGreaterThanOrEqual(2);
      // PR 101 ranks higher than PR 102 due to tests, CI, author history, and approvals
      const ranked101 = ranked.find((p) => p.number === 101);
      const ranked102 = ranked.find((p) => p.number === 102);
      expect(ranked101).toBeDefined();
      expect(ranked102).toBeDefined();
      expect(ranked101!.score).toBeGreaterThan(ranked102!.score);
      expect(ranked101!.signals.hasTests).toBe(1.0);
      expect(ranked102!.signals.hasTests).toBe(0.0);

      // ── STAGE 5.6: VISION ALIGNMENT CHECK ────────────────────────────
      // Deterministic mock embedder matching 4 dimensions
      const deterministicEmbedder: EmbeddingProvider = {
        dimensions: 4,
        embed: async (text: string) => {
          if (text.toLowerCase().includes("vision") || text.toLowerCase().includes("architecture")) {
            return [0.0, 0.0, 0.8, 0.6]; // Aligned with PR 201
          }
          return [0.5, 0.5, 0.5, 0.5];
        },
        embedBatch: async (texts: string[]) => {
          return Promise.all(texts.map((t) => deterministicEmbedder.embed(t)));
        },
      };

      const visionScores = await checkVisionAlignment(store, deterministicEmbedder, config, visionDocPath, repoFull);

      expect(visionScores.length).toBe(5);
      const score201 = visionScores.find((s) => s.prNumber === 201);
      expect(score201).toBeDefined();
      expect(score201?.classification).toBe("aligned");

      const visionSummary = {
        aligned: visionScores.filter((s) => s.classification === "aligned").length,
        drifting: visionScores.filter((s) => s.classification === "drifting").length,
        offVision: visionScores.filter((s) => s.classification === "off-vision").length,
      };
      expect(visionSummary.aligned).toBeGreaterThanOrEqual(1);

      // ── STAGE 5.7: OPTIONAL MOCKED JEV (TYPED DECISION LAYER) ────────
      // Verify default disabled provider makes 0 calls
      const defaultDisabledProvider = createDecisionProvider({ enabled: false });
      expect(defaultDisabledProvider).toBeInstanceOf(DisabledDecisionProvider);

      // Offline MockDecisionProvider for controlled verification
      const mockDecisionProvider = new MockDecisionProvider();

      const decisionReport = await evaluateItemDecisions(normPR1, mockDecisionProvider, {
        prQualityScore: ranked101!.score,
      });

      expect(decisionReport.provenance.decisionSchemaVersion).toBe(TRIAGE_SCHEMA_VERSION);
      expect(decisionReport.classification.itemType).toBe("pr"); // Authoritative GitHub type
      expect(decisionReport.classification.technicalDomain).toBe("core_logic");
      expect(decisionReport.provenance.provider).toBe("mock");
      expect(decisionReport.provenance.rubricHash).toBeDefined();
      expect(decisionReport.advisoryRoute).toBeDefined();

      // Test security escalation precedence with mock answers
      const securityEscalationMock = new MockDecisionProvider({
        presetAnswers: {
          category: {
            type: "choice",
            choice: "other",
            confidence: 0.99,
            probabilities: { other: 1.0 },
          },
          technical_domain: {
            type: "choice",
            choice: "core_logic",
            confidence: 0.99,
            probabilities: { core_logic: 1.0 },
          },
          reproduction_evidence: {
            type: "score",
            score: 2,
            confidence: 0.95,
            probabilities: { "2": 1.0 },
          },
          documentation_completeness: {
            type: "score",
            score: 2,
            confidence: 0.95,
            probabilities: { "2": 1.0 },
          },
          technical_severity: {
            type: "score",
            score: 2,
            confidence: 0.95,
            probabilities: { "2": 1.0 },
          },
          has_security_risk: { type: "noul", noul: 0.95 },
          has_breaking_change: { type: "noul", noul: 0.1 },
          investigation_needed: { type: "noul", noul: 0.2 },
        },
      });

      const securityReport = await evaluateItemDecisions(normIssue50, securityEscalationMock);
      expect(securityReport.advisoryRoute).toBe("security_escalation");

      // ── STAGE 5.8: REPORT GENERATION ─────────────────────────────────
      const reportMarkdown = generateMarkdownReport({
        repoFull,
        date: "2026-10-26",
        stats,
        clusters,
        ranked,
        visionResults: visionSummary,
        topN: 10,
        clusterN: 10,
        verbose: true,
        store,
      });

      expect(reportMarkdown).toContain("# pr-prism triage report");
      expect(reportMarkdown).toContain(`**repo:** ${repoFull}`);
      expect(reportMarkdown).toContain("## duplicate clusters");
      expect(reportMarkdown).toContain("Fix retry backoff timeout in network client");
      expect(reportMarkdown).toContain("contributor-alice");
      expect(reportMarkdown).toContain("ranked PRs");
      expect(reportMarkdown).toContain("vision-aligned");

      // ── STAGE 5.9: WRITE-GATE PROTECTION & SAFETY GUARANTEE ──────────
      // In dry-run mode, labels must NEVER be applied to GitHub
      await client.applyLabel(101, "prism:duplicate");
      await client.removeLabel(101, "needs-triage");
      await client.ensureLabel("prism:duplicate", "cfd3d7", "Duplicate PR or issue");

      // Journal records intended operations without performing any API calls
      expect(writeGate.journal).toHaveLength(3);
      expect(writeGate.journal[0]).toEqual({ kind: "label", target: "#101 +prism:duplicate" });
      expect(writeGate.journal[1]).toEqual({ kind: "label", target: "#101 -needs-triage" });
      expect(writeGate.journal[2]).toEqual({ kind: "label-ensure", target: "prism:duplicate" });

      expect(octokitMock.issues.addLabels).not.toHaveBeenCalled();
      expect(octokitMock.issues.removeLabel).not.toHaveBeenCalled();
      expect(octokitMock.issues.createLabel).not.toHaveBeenCalled();

      // ── STAGE 5.10: NETWORK ISOLATION VERIFICATION ───────────────────
      // Verify zero real network calls were attempted throughout entire execution
      expect(networkAttemptCount).toBe(0);
    } finally {
      store.close();
    }
  });

  it("verifies GitHubClient GraphQL and REST ingest operations using mocked Octokit transport", async () => {
    const writeGate = createWriteGate("dry-run");
    const client = new GitHubClient("mock-token", "owner", "repo", writeGate);

    // Mock GraphQL endpoint
    const mockGraphQLPRResponse = {
      repository: {
        pullRequests: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 1,
              title: "PR One",
              body: "Body One",
              state: "OPEN",
              createdAt: "2026-08-01T00:00:00Z",
              updatedAt: "2026-08-01T00:00:00Z",
              author: { login: "author1" },
              additions: 10,
              deletions: 2,
              changedFiles: 1,
              labels: { nodes: [] },
              files: { nodes: [] },
              reviews: { totalCount: 0, nodes: [] },
              commits: { nodes: [] },
            },
          ],
        },
      },
    };

    const mockGraphQLIssueResponse = {
      repository: {
        issues: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 2,
              title: "Issue Two",
              body: "Body Two",
              state: "OPEN",
              createdAt: "2026-08-01T00:00:00Z",
              updatedAt: "2026-08-01T00:00:00Z",
              author: { login: "author2" },
              labels: { nodes: [] },
            },
          ],
        },
      },
    };

    const mockOctokit = {
      graphql: vi.fn(async (query: string | { query: string }) => {
        const queryStr = typeof query === "string" ? query : query?.query || "";
        if (queryStr.includes("pullRequests")) {
          return mockGraphQLPRResponse;
        }
        if (queryStr.includes("issues")) {
          return mockGraphQLIssueResponse;
        }
        return mockGraphQLPRResponse;
      }),
      pulls: {
        list: vi.fn(async ({ page }: { page?: number } = {}) => ({
          data:
            (page ?? 1) === 1
              ? [
                  {
                    number: 10,
                    title: "REST PR 10",
                    body: "REST PR Body",
                    state: "open",
                    user: { login: "rest-user" },
                    created_at: "2026-08-01T00:00:00Z",
                    updated_at: "2026-08-01T00:00:00Z",
                    labels: [],
                  },
                ]
              : [],
          headers: {
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1700000000",
          },
        })),
      },
      issues: {
        listForRepo: vi.fn(async ({ page }: { page?: number } = {}) => ({
          data:
            (page ?? 1) === 1
              ? [
                  {
                    number: 20,
                    title: "REST Issue 20",
                    body: "REST Issue Body",
                    state: "open",
                    user: { login: "rest-issue-user" },
                    created_at: "2026-08-01T00:00:00Z",
                    updated_at: "2026-08-01T00:00:00Z",
                    labels: [],
                  },
                ]
              : [],
          headers: {
            "x-ratelimit-remaining": "4998",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1700000000",
          },
        })),
      },
    };

    (client as unknown as { octokit: unknown }).octokit = mockOctokit;

    // Test GraphQL fetching
    const prsGQL = await client.fetchPRsGraphQL({ maxItems: 10 });
    expect(prsGQL).toHaveLength(1);
    expect(prsGQL[0].number).toBe(1);
    expect(prsGQL[0].title).toBe("PR One");

    const issuesGQL = await client.fetchIssuesGraphQL({ maxItems: 10 });
    expect(issuesGQL).toHaveLength(1);
    expect(issuesGQL[0].number).toBe(2);
    expect(issuesGQL[0].title).toBe("Issue Two");

    // Test REST fetching
    const prsREST = await client.fetchPRs({ maxItems: 10 });
    expect(prsREST).toHaveLength(1);
    expect(prsREST[0].number).toBe(10);
    expect(prsREST[0].title).toBe("REST PR 10");

    const issuesREST = await client.fetchIssues({ maxItems: 10 });
    expect(issuesREST).toHaveLength(1);
    expect(issuesREST[0].number).toBe(20);
    expect(issuesREST[0].title).toBe("REST Issue 20");
  });

  it("verifies that unauthorized network calls are strictly intercepted and blocked", async () => {
    // Attempting external fetch throws error and increments count
    await expect(globalThis.fetch("https://api.github.com")).rejects.toThrow(
      "CRITICAL VIOLATION: Offline E2E harness blocked unauthorized external globalThis.fetch call",
    );
    expect(networkAttemptCount).toBe(1);

    // Reset attempt count back to 0 for pristine suite state
    networkAttemptCount = 0;
  });
});
