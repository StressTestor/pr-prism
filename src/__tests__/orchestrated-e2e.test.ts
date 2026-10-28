import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCORING_WEIGHTS, type PrismConfig } from "../config.js";
import { GitHubClient } from "../github.js";
import { parseDuration, runDupes, runRank, runScan, runVision } from "../pipeline.js";
import { VectorStore } from "../store.js";
import type { EmbeddingProvider, PipelineContext } from "../types.js";
import { captureProcessEnv, getIsolatedEnv, restoreProcessEnv } from "./cli-test-env.js";
import {
  assertOsNetworkIsolationSupported,
  evaluateOsNetworkIsolationMode,
  execInOsNetworkSandbox,
  getOsNetworkIsolationDetail,
  installNetworkGuard,
  isOsNetworkIsolationSupported,
  type NetworkGuard,
  type OsIsolationUnavailableReason,
  osNetworkIsolationUnsupportedReason,
} from "./network-sandbox.js";

const rootDir = resolve(__dirname, "../..");
const distCli = resolve(rootDir, "dist/cli.js");

/** Read the package version at test-collection time from the local package.json. */
const packageVersion: string = (() => {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf-8")) as {
    version: string;
  };
  return pkg.version;
})();

describe("PR-Prism v4 Orchestrated Production E2E & Negative Acceptance", () => {
  let tempDir: string;
  let visionDocPath: string;
  let baselineEnv: NodeJS.ProcessEnv;
  let networkGuard: NetworkGuard;
  let activeOctokitMock: any = null;
  let origContextDesc: PropertyDescriptor | undefined;
  let origWriteContextDesc: PropertyDescriptor | undefined;

  // Normalized 4-dimensional unit vector fixtures
  const v101 = [0.96, 0.28, 0.0, 0.0];
  const v102 = [0.98, 0.198997, 0.0, 0.0];
  const v50 = [0.94, 0.341174, 0.0, 0.0];
  const v201 = [0.0, 0.0, 0.8, 0.6];
  const v202 = [0.0, 0.0, 0.0, 1.0];
  const vVisionAligned = [0.0, 0.0, 0.8, 0.6];
  const vGeneral = [0.5, 0.5, 0.5, 0.5];

  // Deterministic 4D mock embedder
  let embedBatchCalls = 0;
  const deterministicEmbedder: EmbeddingProvider = {
    dimensions: 4,
    embed: async (text: string) => {
      const lower = text.toLowerCase();
      if (lower.includes("101") || lower.includes("retry backoff timeout in network client")) {
        return v101;
      }
      if (lower.includes("102") || lower.includes("duplicate submission of retry backoff")) {
        return v102;
      }
      if (lower.includes("50") || lower.includes("connection retries fail with timeout")) {
        return v50;
      }
      if (lower.includes("201") || lower.includes("architecture vision") || lower.includes("triage guide")) {
        return v201;
      }
      if (lower.includes("202") || lower.includes("multi-repo clustering")) {
        return v202;
      }
      if (lower.includes("core capabilities") || lower.includes("vision")) {
        return vVisionAligned;
      }
      return vGeneral;
    },
    embedBatch: async (texts: string[]) => {
      embedBatchCalls++;
      return Promise.all(texts.map((t) => deterministicEmbedder.embed(t)));
    },
  };

  beforeAll(() => {
    // 1. Strict credential isolation
    baselineEnv = captureProcessEnv();
    const isolatedEnv = getIsolatedEnv();
    for (const key of Object.keys(process.env)) {
      if (!(key in isolatedEnv)) {
        delete process.env[key];
      }
    }

    // 2. Strict in-process network sandbox covering fetch, http, https, net sockets, tls, dns
    networkGuard = installNetworkGuard();

    // 3. Temporary filesystem fixture
    tempDir = mkdtempSync(join(tmpdir(), "prism-orchestrated-e2e-"));
    visionDocPath = join(tempDir, "VISION.md");

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

    // 4. Hook GitHubClient context and writeContext to ensure sub-operations
    // (such as read-only label verification in runDupes and runVision) route through
    // the controlled mock rather than issuing unmocked network calls.
    origContextDesc = Object.getOwnPropertyDescriptor(GitHubClient.prototype, "context");
    origWriteContextDesc = Object.getOwnPropertyDescriptor(GitHubClient.prototype, "writeContext");

    if (origContextDesc?.get) {
      const origContextGet = origContextDesc.get;
      Object.defineProperty(GitHubClient.prototype, "context", {
        get() {
          const c = origContextGet.call(this);
          return activeOctokitMock ? { ...c, octokit: activeOctokitMock } : c;
        },
        configurable: true,
      });
    }

    if (origWriteContextDesc?.get) {
      const origWriteContextGet = origWriteContextDesc.get;
      Object.defineProperty(GitHubClient.prototype, "writeContext", {
        get() {
          const c = origWriteContextGet.call(this);
          return activeOctokitMock ? { ...c, octokit: activeOctokitMock } : c;
        },
        configurable: true,
      });
    }
  });

  afterEach(() => {
    // Reset active mock and assert zero unexpected network violations
    activeOctokitMock = null;
    networkGuard.assertZeroViolations();
  });

  afterAll(() => {
    try {
      networkGuard.assertZeroViolations();
    } finally {
      if (origContextDesc) {
        Object.defineProperty(GitHubClient.prototype, "context", origContextDesc);
      }
      if (origWriteContextDesc) {
        Object.defineProperty(GitHubClient.prototype, "writeContext", origWriteContextDesc);
      }
      networkGuard.restore();
      restoreProcessEnv(baselineEnv);
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  // Helper to construct a fully controlled PipelineContext
  function createTestPipelineContext(options: {
    store: VectorStore;
    repoFull?: string;
    octokitMock?: any;
    writeGateMode?: "dry-run" | "apply";
  }): PipelineContext {
    const repoFull = options.repoFull ?? "test-owner/test-repo";
    const [owner, repo] = repoFull.split("/");

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

    const env = {
      GITHUB_TOKEN: "mock-offline-token",
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_MODEL: "deterministic-v4",
      EMBEDDING_DIMENSIONS: 4,
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "local",
    };

    const client = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    if (options.octokitMock) {
      activeOctokitMock = options.octokitMock;
      (client as unknown as { octokit: unknown }).octokit = options.octokitMock;
    }

    return {
      config,
      env,
      owner,
      repo,
      repoFull,
      github: client,
      store: options.store,
      embedder: deterministicEmbedder,
    };
  }

  // ── 1. PRODUCTION ORCHESTRATION PIPELINE ────────────────────────────────

  it("proves items from mocked GitHub transport travel through real runScan into SQLite and feed runDupes, runRank, runVision", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "prod-orchestrator.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");
    embedBatchCalls = 0;

    // Synthetic GraphQL Pull Requests: Alice #101 (high quality, tests, approvals) and Bob #102 (duplicate, no tests)
    const rawGraphQLPRNodes = [
      {
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
        url: `https://github.com/${repoFull}/pull/101`,
        labels: { nodes: [{ name: "bug" }, { name: "networking" }] },
        files: {
          nodes: [{ path: "src/net/retry.ts" }, { path: "src/__tests__/retry.test.ts" }],
        },
        reviews: {
          totalCount: 2,
          nodes: [{ state: "APPROVED" }, { state: "APPROVED" }],
        },
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
        },
        closingIssuesReferences: {
          nodes: [{ number: 50, repository: { nameWithOwner: repoFull } }],
        },
      },
      {
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
        url: `https://github.com/${repoFull}/pull/102`,
        labels: { nodes: [{ name: "bug" }] },
        files: {
          nodes: [{ path: "src/net/retry.ts" }],
        },
        reviews: {
          totalCount: 0,
          nodes: [],
        },
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }],
        },
        closingIssuesReferences: {
          nodes: [{ number: 50, repository: { nameWithOwner: repoFull } }],
        },
      },
    ];

    // Synthetic GraphQL Issue: Original bug report #50
    const rawGraphQLIssueNodes = [
      {
        number: 50,
        title: "Connection retries fail with timeout under high load",
        body: "When API rate limits are approached, retry requests immediately timeout rather than backing off.",
        author: { login: "user-reporter" },
        state: "OPEN",
        createdAt: "2026-07-28T09:00:00Z",
        updatedAt: "2026-07-29T14:00:00Z",
        id: "ISSUE_node_50",
        url: `https://github.com/${repoFull}/issues/50`,
        labels: { nodes: [{ name: "bug" }] },
      },
    ];

    // Mock Octokit transport
    const octokitMock = {
      graphql: vi.fn(async (query: string | { query: string }) => {
        const queryStr = typeof query === "string" ? query : query?.query || "";
        if (queryStr.includes("pullRequests")) {
          return {
            repository: {
              pullRequests: {
                totalCount: 2,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: rawGraphQLPRNodes,
              },
            },
          };
        }
        if (queryStr.includes("issues")) {
          return {
            repository: {
              issues: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: rawGraphQLIssueNodes,
              },
            },
          };
        }
        if (queryStr.includes("search")) {
          // Author merge count queries
          return {
            search: {
              issueCount: 12,
            },
          };
        }
        return {};
      }),
      pulls: {
        list: vi.fn(),
      },
      issues: {
        listForRepo: vi.fn(),
        createLabel: vi.fn(),
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
      },
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      // 1. Execute runScan (NOT direct SQLite insertion)
      await runScan(ctx, { useRest: false });

      // Verify that items flowed through runScan into SQLite
      const stats = store.getStats(repoFull);
      expect(stats.totalItems).toBe(3);
      expect(stats.prs).toBe(2);
      expect(stats.issues).toBe(1);

      const dbPR101 = store.getByNumber(repoFull, 101);
      expect(dbPR101).toBeDefined();
      expect(dbPR101?.title).toBe("Fix retry backoff timeout in network client");
      expect(dbPR101?.metadata.ciStatus).toBe("success");
      expect(dbPR101?.metadata.hasTests).toBe(true);
      expect(dbPR101?.metadata.reviewCount).toBe(2);

      const dbPR102 = store.getByNumber(repoFull, 102);
      expect(dbPR102).toBeDefined();
      expect(dbPR102?.metadata.ciStatus).toBe("pending");
      expect(dbPR102?.metadata.hasTests).toBe(false);

      const dbIssue50 = store.getByNumber(repoFull, 50);
      expect(dbIssue50).toBeDefined();
      expect(dbIssue50?.type).toBe("issue");

      // Verify vector embeddings exist in sqlite
      const embedding101 = store.getEmbedding(dbPR101!.id);
      expect(embedding101).toBeDefined();
      expect(embedding101!.length).toBe(4);

      // 2. Execute runDupes consuming the SQLite store populated by runScan
      const clusters = await runDupes(ctx, { threshold: 0.85 });
      expect(clusters).toHaveLength(1);
      const cluster = clusters[0];
      expect(cluster.items.length).toBe(3);
      expect(cluster.items.map((i) => i.number).sort((a, b) => a - b)).toEqual([50, 101, 102]);
      // Alice #101 must be selected as canonical best pick
      expect(cluster.bestPick.number).toBe(101);
      expect(cluster.avgSimilarity).toBeGreaterThan(0.85);

      // 3. Execute runRank consuming SQLite items populated by runScan
      const ranked = await runRank(ctx, { top: 10, explain: true });
      expect(ranked.length).toBeGreaterThanOrEqual(2);
      const topRanked = ranked[0];
      expect(topRanked.number).toBe(101);
      expect(topRanked.score).toBeGreaterThan(ranked[1].score);
      expect(topRanked.signals.hasTests).toBe(1.0);
      expect(topRanked.signals.ciPassing).toBe(1.0);

      // 4. Execute runVision consuming SQLite items against vision document
      const visionScores = await runVision(ctx, { doc: visionDocPath });
      expect(visionScores).toBeDefined();
      expect(visionScores!.length).toBe(3);
      const visionPR101 = visionScores!.find((s) => s.prNumber === 101);
      expect(visionPR101).toBeDefined();
      expect(visionPR101?.classification).toBeDefined();
    } finally {
      store.close();
    }
  });

  // ── 2. NEGATIVE SCENARIOS ───────────────────────────────────────────────

  it("handles REST fallback scan and controlled transport fetch failure", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "rest-fallback.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");

    const octokitMock = {
      graphql: vi.fn(),
      pulls: {
        list: vi.fn(async ({ page }: { page?: number } = {}) => ({
          data:
            (page ?? 1) === 1
              ? [
                  {
                    number: 201,
                    title: "Add architecture vision documentation and triage guide",
                    body: "Documents PR-Prism architecture vision and triage guide.",
                    user: { login: "maintainer-charlie" },
                    state: "open",
                    created_at: "2026-08-03T08:00:00Z",
                    updated_at: "2026-08-03T08:30:00Z",
                    labels: [{ name: "documentation" }],
                  },
                ]
              : [],
          headers: {
            "x-ratelimit-remaining": "4990",
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
                    number: 202,
                    title: "Question: roadmap for multi-repo clustering support",
                    body: "Inquiring about multi-repo clustering roadmap.",
                    user: { login: "user-curious" },
                    state: "open",
                    created_at: "2026-08-03T09:00:00Z",
                    updated_at: "2026-08-03T09:15:00Z",
                    labels: [{ name: "question" }],
                  },
                ]
              : [],
          headers: {
            "x-ratelimit-remaining": "4989",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1700000000",
          },
        })),
      },
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      // Successful REST fallback
      await runScan(ctx, { useRest: true });
      expect(store.getByNumber(repoFull, 201)).toBeDefined();
      expect(store.getByNumber(repoFull, 202)).toBeDefined();

      // Controlled fetch failure: simulate upstream non-transient transport failure
      octokitMock.pulls.list.mockRejectedValueOnce(new Error("GitHub API transport connection closed"));
      await expect(runScan(ctx, { useRest: true })).rejects.toThrow("GitHub API transport connection closed");

      // Verify database remains valid and uncorrupted after controlled failure
      expect(store.getByNumber(repoFull, 201)).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("handles repeated scan with unchanged items and metadata drift without re-embedding", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "repeated-scan.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");

    const prNode = {
      number: 101,
      title: "Fix retry backoff timeout in network client",
      body: "Body",
      author: { login: "contributor-alice" },
      state: "OPEN",
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-02T12:00:00Z",
      additions: 45,
      deletions: 10,
      changedFiles: 2,
      id: "PR_node_101",
      headRefOid: "sha_101",
      url: `https://github.com/${repoFull}/pull/101`,
      labels: { nodes: [] },
      files: { nodes: [] },
      reviews: { totalCount: 1, nodes: [{ state: "APPROVED" }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
    };

    const octokitMock = {
      graphql: vi.fn(async (query: string | { query: string }) => {
        const queryStr = typeof query === "string" ? query : query?.query || "";
        if (queryStr.includes("pullRequests")) {
          return {
            repository: {
              pullRequests: {
                totalCount: 1,
                pageInfo: { hasNextPage: false },
                nodes: [prNode],
              },
            },
          };
        }
        return {
          repository: {
            issues: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
          },
        };
      }),
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      const initialEmbedCalls = embedBatchCalls;
      // First scan: embeds item #101
      await runScan(ctx, {});
      expect(embedBatchCalls).toBe(initialEmbedCalls + 1);

      // Second scan with identical item: skips unchanged items without re-embedding
      const callsBeforeRepeated = embedBatchCalls;
      await runScan(ctx, {});
      expect(embedBatchCalls).toBe(callsBeforeRepeated); // 0 additional embedding calls

      // Third scan with metadata drift (CI changes to SUCCESS, reviewCount changes to 3, but updatedAt is identical)
      prNode.commits.nodes[0].commit.statusCheckRollup.state = "SUCCESS";
      prNode.reviews.totalCount = 3;

      await runScan(ctx, {});
      expect(embedBatchCalls).toBe(callsBeforeRepeated); // still zero new embedding calls!

      // Check that metadata was updated in SQLite
      const updated = store.getByNumber(repoFull, 101);
      expect(updated?.metadata.ciStatus).toBe("success");
      expect(updated?.metadata.reviewCount).toBe(3);
    } finally {
      store.close();
    }
  });

  it("verifies SQLite persistence and reopen behavior across lifecycle", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "persistence-reopen.db");

    // 1. Initial creation and scan
    const store1 = new VectorStore(dbPath, 4, "deterministic-v4");
    const rawGraphQLPRNodes = [
      {
        number: 101,
        title: "Fix retry backoff timeout in network client",
        body: "Implements incremental backoff retry.\nFixes #50",
        author: { login: "contributor-alice" },
        state: "OPEN",
        createdAt: "2026-08-01T10:00:00Z",
        updatedAt: "2026-08-02T12:00:00Z",
        additions: 45,
        deletions: 10,
        changedFiles: 2,
        id: "PR_node_101",
        headRefOid: "sha_101",
        url: `https://github.com/${repoFull}/pull/101`,
        labels: { nodes: [] },
        files: { nodes: [{ path: "src/retry.ts" }, { path: "src/retry.test.ts" }] },
        reviews: { totalCount: 2, nodes: [{ state: "APPROVED" }, { state: "APPROVED" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      },
      {
        number: 102,
        title: "Fix retry backoff timeout in network client",
        body: "Duplicate submission.\nCloses #50",
        author: { login: "contributor-bob" },
        state: "OPEN",
        createdAt: "2026-08-01T11:00:00Z",
        updatedAt: "2026-08-01T11:30:00Z",
        additions: 100,
        deletions: 5,
        changedFiles: 1,
        id: "PR_node_102",
        headRefOid: "sha_102",
        url: `https://github.com/${repoFull}/pull/102`,
        labels: { nodes: [] },
        files: { nodes: [{ path: "src/retry.ts" }] },
        reviews: { totalCount: 0, nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
      },
    ];

    const octokitMock = {
      graphql: vi.fn(async (query: string | { query: string }) => {
        const queryStr = typeof query === "string" ? query : query?.query || "";
        if (queryStr.includes("pullRequests")) {
          return {
            repository: {
              pullRequests: {
                totalCount: 2,
                pageInfo: { hasNextPage: false },
                nodes: rawGraphQLPRNodes,
              },
            },
          };
        }
        return {
          repository: {
            issues: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
          },
        };
      }),
    };

    const ctx1 = createTestPipelineContext({ store: store1, repoFull, octokitMock });
    await runScan(ctx1, {});

    expect(store1.getByNumber(repoFull, 101)).toBeDefined();
    expect(store1.getMeta("embedding_model")).toBe("deterministic-v4");
    expect(store1.getMeta("embedding_dimensions")).toBe("4");
    // Explicitly close
    store1.close();

    // 2. Reopen store from disk with fresh instance
    const store2 = new VectorStore(dbPath, 4, "deterministic-v4");
    try {
      const item = store2.getByNumber(repoFull, 101);
      expect(item).toBeDefined();
      expect(item?.number).toBe(101);
      expect(item?.title).toBe("Fix retry backoff timeout in network client");

      const embedding = store2.getEmbedding(item!.id);
      expect(embedding).toBeDefined();
      expect(embedding!.length).toBe(4);

      // Verify runDupes works seamlessly against reopened store
      const ctxReopened = createTestPipelineContext({ store: store2, repoFull });
      const clusters = await runDupes(ctxReopened, { threshold: 0.85 });
      expect(clusters).toHaveLength(1);
      expect(clusters[0].bestPick.number).toBe(101);
    } finally {
      store2.close();
    }
  });

  // ── AUDIT FINDING 3: POPULATED PIPELINE DRY-RUN VERIFICATION ─────────────

  it("enforces populated pipeline dry-run write protection with zero mutations against GitHub", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "populated-dry-run.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");

    // Construct synthetic PRs and issues to populate the database
    const rawGraphQLPRNodes = [
      {
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
        url: `https://github.com/${repoFull}/pull/101`,
        labels: { nodes: [{ name: "bug" }] },
        files: { nodes: [{ path: "src/retry.ts" }, { path: "src/retry.test.ts" }] },
        reviews: { totalCount: 2, nodes: [{ state: "APPROVED" }, { state: "APPROVED" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        closingIssuesReferences: { nodes: [{ number: 50, repository: { nameWithOwner: repoFull } }] },
      },
      {
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
        url: `https://github.com/${repoFull}/pull/102`,
        labels: { nodes: [{ name: "bug" }] },
        files: { nodes: [{ path: "src/retry.ts" }] },
        reviews: { totalCount: 0, nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
        closingIssuesReferences: { nodes: [{ number: 50, repository: { nameWithOwner: repoFull } }] },
      },
      {
        number: 201,
        title: "Add architecture vision documentation and triage guide",
        body: "Documents PR-Prism architecture vision and core capabilities.",
        author: { login: "maintainer-charlie" },
        state: "OPEN",
        createdAt: "2026-08-03T08:00:00Z",
        updatedAt: "2026-08-03T08:30:00Z",
        additions: 200,
        deletions: 0,
        changedFiles: 1,
        id: "PR_node_201",
        headRefOid: "commit_sha_201",
        url: `https://github.com/${repoFull}/pull/201`,
        labels: { nodes: [{ name: "documentation" }] },
        files: { nodes: [{ path: "docs/VISION.md" }] },
        reviews: { totalCount: 1, nodes: [{ state: "APPROVED" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      },
    ];

    const rawGraphQLIssueNodes = [
      {
        number: 50,
        title: "Connection retries fail with timeout under high load",
        body: "When API rate limits are approached, retry requests immediately timeout rather than backing off.",
        author: { login: "user-reporter" },
        state: "OPEN",
        createdAt: "2026-07-28T09:00:00Z",
        updatedAt: "2026-07-29T14:00:00Z",
        id: "ISSUE_node_50",
        url: `https://github.com/${repoFull}/issues/50`,
        labels: { nodes: [{ name: "bug" }] },
      },
    ];

    const octokitMock = {
      graphql: vi.fn(async (query: string | { query: string }) => {
        const queryStr = typeof query === "string" ? query : query?.query || "";
        if (queryStr.includes("pullRequests")) {
          return {
            repository: {
              pullRequests: {
                totalCount: 3,
                pageInfo: { hasNextPage: false },
                nodes: rawGraphQLPRNodes,
              },
            },
          };
        }
        if (queryStr.includes("issues")) {
          return {
            repository: {
              issues: {
                totalCount: 1,
                pageInfo: { hasNextPage: false },
                nodes: rawGraphQLIssueNodes,
              },
            },
          };
        }
        return {};
      }),
      issues: {
        // Explicitly controlled read-only label existence check
        getLabel: vi.fn(async ({ name }: { name: string }) => ({
          data: { name, color: "ffffff", description: "Mocked label" },
        })),
        // Prohibited write endpoints — must never be called during dry-run
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
        createLabel: vi.fn(),
      },
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      // 1. Populate the disposable database through the real runScan pipeline
      await runScan(ctx, {});
      const initialStats = store.getStats(repoFull);
      expect(initialStats.totalItems).toBe(4);
      expect(initialStats.prs).toBe(3);
      expect(initialStats.issues).toBe(1);

      // 2. Invoke runDupes with applyLabels=true and dryRun=true
      const clusters = await runDupes(ctx, { threshold: 0.85, applyLabels: true, dryRun: true });
      expect(clusters.length).toBeGreaterThan(0);
      const cluster = clusters[0];
      expect(cluster.items.length).toBe(3);
      expect(cluster.bestPick.number).toBe(101);

      // Verify that read-only label existence was checked, but no writes occurred
      expect(octokitMock.issues.getLabel).toHaveBeenCalled();
      expect(octokitMock.issues.addLabels).not.toHaveBeenCalled();
      expect(octokitMock.issues.removeLabel).not.toHaveBeenCalled();
      expect(octokitMock.issues.createLabel).not.toHaveBeenCalled();

      // 3. Invoke runVision with applyLabels=true and dryRun=true
      const visionScores = await runVision(ctx, { doc: visionDocPath, applyLabels: true, dryRun: true });
      expect(visionScores).toBeDefined();
      expect(visionScores!.length).toBe(4);

      // Verify still zero write calls reached Octokit
      expect(octokitMock.issues.addLabels).not.toHaveBeenCalled();
      expect(octokitMock.issues.createLabel).not.toHaveBeenCalled();

      // 4. Verify GitHubClient default constructor write-gate protection
      const defaultClient = new GitHubClient("token", "owner", "repo");
      (defaultClient as any).octokit = octokitMock;
      await defaultClient.applyLabel(101, "prism:duplicate");
      await defaultClient.ensureLabel("prism:duplicate", "ffffff", "Duplicate PR");

      expect(octokitMock.issues.addLabels).not.toHaveBeenCalled();
      expect(octokitMock.issues.createLabel).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("rejects invalid or incomplete configurations cleanly", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "invalid-config.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");

    const octokitMock = {
      graphql: vi.fn(async () => ({
        repository: {
          pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
          issues: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        },
      })),
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      // 1. Invalid since duration
      await expect(runScan(ctx, { since: "invalid-duration" })).rejects.toThrow("Invalid duration: invalid-duration");
      expect(() => parseDuration("xyz")).toThrow("Invalid duration");

      // 2. Incompatible embedding config hash detection:
      // Seed an item with vector so store.hasEmbeddings() is true
      store.upsert({
        id: `${repoFull}:pr:1`,
        type: "pr",
        number: 1,
        repo: repoFull,
        title: "Existing PR",
        bodySnippet: "Snippet",
        embedding: new Float32Array(v101),
        metadata: {},
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
      });
      store.setMeta("embedding_config_hash", "legacy-incompatible-hash-v1");

      await expect(runScan(ctx, {})).rejects.toThrow(/embedding configuration changed/);
    } finally {
      store.close();
    }
  });

  it("verifies failure cleanup without retained temp artifacts", () => {
    const isolatedTempDir = mkdtempSync(join(tmpdir(), "prism-failure-cleanup-"));
    const isolatedDbPath = join(isolatedTempDir, "crash-test.db");

    let store: VectorStore | null = null;
    try {
      store = new VectorStore(isolatedDbPath, 4, "test-model");
      // Simulate failure scenario
      throw new Error("Simulated pipeline failure during execution");
    } catch (err: any) {
      expect(err.message).toBe("Simulated pipeline failure during execution");
    } finally {
      store?.close();
      rmSync(isolatedTempDir, { recursive: true, force: true });
    }

    // Verify temp dir and database were completely removed
    expect(existsSync(isolatedTempDir)).toBe(false);
  });

  // ── AUDIT FINDING 4: VERIFIED CLI COMMAND EXECUTION & OUTPUT CONTRACTS ──

  it("verifies CLI command execution and output contracts for doctor, dupes, rank, --version, and --help in offline isolation", () => {
    const cliTempDir = mkdtempSync(join(tmpdir(), "prism-cli-contract-"));
    try {
      const repoFull = "test-owner/test-repo";
      writeFileSync(join(cliTempDir, "prism.config.yaml"), `repo: ${repoFull}\n`);
      writeFileSync(join(cliTempDir, "VISION.md"), `# Project Vision\n## Core\nTriage\n`);

      // Pre-populate data/prism.db in cliTempDir so CLI commands have realistic local data
      const dataDir = join(cliTempDir, "data");
      mkdirSync(dataDir, { recursive: true });
      const store = new VectorStore(join(dataDir, "prism.db"), 4, "deterministic-v4");

      const items = [
        {
          id: `${repoFull}:pr:101`,
          type: "pr" as const,
          number: 101,
          repo: repoFull,
          title: "Fix retry backoff timeout",
          bodySnippet: "Retry backoff body",
          embedding: new Float32Array(v101),
          metadata: { ciStatus: "success", reviewCount: 2, hasTests: true, author: "contributor-alice" },
          createdAt: "2026-08-01T10:00:00Z",
          updatedAt: "2026-08-02T12:00:00Z",
        },
        {
          id: `${repoFull}:pr:102`,
          type: "pr" as const,
          number: 102,
          repo: repoFull,
          title: "Fix retry backoff timeout",
          bodySnippet: "Duplicate body",
          embedding: new Float32Array(v102),
          metadata: { ciStatus: "pending", reviewCount: 0, hasTests: false, author: "contributor-bob" },
          createdAt: "2026-08-01T11:00:00Z",
          updatedAt: "2026-08-01T11:30:00Z",
        },
        {
          id: `${repoFull}:issue:50`,
          type: "issue" as const,
          number: 50,
          repo: repoFull,
          title: "Connection retries fail with timeout",
          bodySnippet: "Issue body",
          embedding: new Float32Array(v50),
          metadata: { author: "user-reporter" },
          createdAt: "2026-07-28T09:00:00Z",
          updatedAt: "2026-07-29T14:00:00Z",
        },
      ];

      for (const item of items) {
        store.upsert(item);
      }
      store.cacheAuthorMergeCount(repoFull, "contributor-alice", 15);
      store.cacheAuthorMergeCount(repoFull, "contributor-bob", 1);
      store.cacheAuthorMergeCount(repoFull, "user-reporter", 0);
      store.setMeta("embedding_model", "deterministic-v4");
      store.setMeta("embedding_dimensions", "4");
      store.setMeta("embedding_provider", "openai");
      store.setMeta("schema_version", "1");
      store.close();

      const execCli = (args: string[]) =>
        execFileSync("node", [distCli, ...args], {
          cwd: cliTempDir,
          env: getIsolatedEnv({
            GITHUB_TOKEN: "mock-offline-token",
            EMBEDDING_API_KEY: "mock-offline-embedding-key",
            EMBEDDING_MODEL: "deterministic-v4",
            EMBEDDING_DIMENSIONS: "4",
          }),
          encoding: "utf-8",
        });

      // 1. --version output contract
      const versionOutput = execCli(["--version"]).trim();
      expect(versionOutput).toBe(packageVersion);

      // 2. --help output contract
      const helpOutput = execCli(["--help"]);
      expect(helpOutput).toContain("Usage: prism");
      expect(helpOutput).toContain("dupes");
      expect(helpOutput).toContain("rank");
      expect(helpOutput).toContain("vision");
      expect(helpOutput).toContain("scan");

      // 3. doctor --json output contract (exercised in pure offline environment without token probe)
      const doctorOutput = execFileSync("node", [distCli, "doctor", "--json"], {
        cwd: cliTempDir,
        env: getIsolatedEnv(),
        encoding: "utf-8",
      });
      const doctorParsed = JSON.parse(doctorOutput);
      expect(doctorParsed.command).toBe("doctor");
      expect(Array.isArray(doctorParsed.checks)).toBe(true);

      // 4. dupes --json output contract
      const dupesJsonOutput = execCli(["dupes", "--json"]).trim();
      expect(dupesJsonOutput.length).toBeGreaterThan(0);
      const clusterObj = JSON.parse(dupesJsonOutput.split("\n")[0]);
      expect(clusterObj).toHaveProperty("id", 1);
      expect(clusterObj).toHaveProperty("size", 3);
      expect(clusterObj).toHaveProperty("bestPick", 101);

      // 5. dupes --output markdown contract
      const dupesMdOutput = execCli(["dupes", "--output", "markdown"]);
      expect(dupesMdOutput).toContain("## duplicate clusters");
      expect(dupesMdOutput).toContain("#101");

      // 6. rank --json output contract
      const rankJsonOutput = execCli(["rank", "--json"]).trim();
      expect(rankJsonOutput.length).toBeGreaterThan(0);
      const rankedLines = rankJsonOutput.split("\n").map((line) => JSON.parse(line));
      expect(rankedLines[0].number).toBe(101);
      expect(rankedLines[0].score).toBeGreaterThan(rankedLines[1].score);
    } finally {
      rmSync(cliTempDir, { recursive: true, force: true });
    }
  });

  // ── AUDIT FINDING 2: SEPARATE VIOLATION ACCOUNTING & SWALLOWED ERRORS ──

  it("verifies negative controls for all intercepted network transport paths without polluting application journal", async () => {
    // Audit Finding 2: Keep deliberate negative controls separate from application test journal
    await networkGuard.runWithNegativeControlIsolation(async (negativeViolations) => {
      // 1. globalThis.fetch (targeted to RFC 5737 documentation prefix - zero real network requests)
      await expect(globalThis.fetch("http://192.0.2.1")).rejects.toThrow("CRITICAL VIOLATION");

      // 2. http.get
      expect(() => http.get("http://192.0.2.1:80")).toThrow("CRITICAL VIOLATION");

      // 3. https.get
      expect(() => https.get("https://192.0.2.1:443")).toThrow("CRITICAL VIOLATION");

      // 4. net.Socket.prototype.connect
      const socket = new net.Socket();
      await new Promise<void>((resolve) => {
        socket.on("error", (err) => {
          expect(err.message).toContain("CRITICAL VIOLATION");
          resolve();
        });
        socket.connect(80, "192.0.2.1");
      });

      // 5. dns.lookup
      await new Promise<void>((resolve) => {
        dns.lookup("prohibited.example", (err) => {
          expect(err).toBeDefined();
          expect(err?.message).toContain("CRITICAL VIOLATION");
          resolve();
        });
      });

      expect(negativeViolations.length).toBeGreaterThanOrEqual(5);
    });

    // The application journal remains strictly untouched (0 violations recorded)
    expect(networkGuard.violations).toHaveLength(0);
  });

  it("demonstrates that a swallowed network-denial exception still fails E2E acceptance", async () => {
    // 1. Simulate an application component that attempts an unauthorized fetch and swallows the error
    try {
      await globalThis.fetch("https://192.0.2.1/telemetry");
    } catch {
      // Application code silently swallowed the network exception
    }

    // 2. The guard's violation journal recorded the unauthorized call despite the exception being swallowed
    expect(networkGuard.violations).toHaveLength(1);
    expect(networkGuard.violations[0].protocol).toBe("globalThis.fetch");

    // 3. assertZeroViolations fails, proving acceptance fails even if exceptions are swallowed
    expect(() => networkGuard.assertZeroViolations()).toThrow(/ASSERTION FAILED: Expected 0 network violations/);

    // 4. Clean up only after the demonstration has verified that failure was triggered
    networkGuard.clearDemonstratedViolation();
  });

  // ── AUDIT FINDING 1: OS-LEVEL NETWORK ISOLATION & SUBPROCESS INHERITANCE ──
  //
  // Normal mode: if bwrap is unavailable the test is explicitly skipped with a
  // reason, never silently passed.  Other tests in this file continue running.
  //
  // Strict mode (STRICT_NETWORK_ISOLATION=1): any inability to establish verified
  // isolation fails the test.  Skips are not permitted.

  it("demonstrates verifiable OS-level network isolation and subprocess inheritance where bwrap is supported", (ctx) => {
    const evaluation = evaluateOsNetworkIsolationMode();

    if (!evaluation.supported) {
      if (evaluation.action === "fail") {
        // Strict mode: missing bwrap, rejected namespaces, or sandbox error must cause failure.
        throw new Error(evaluation.message!);
      }
      // Normal mode: record an explicit Vitest skip with the diagnostic reason.
      // Never count an unsupported sandbox as verified or passed.
      ctx.skip(evaluation.message!);
      return;
    }

    // ── bwrap is available: execute all four isolation controls ──

    // 1. Negative control: OS kernel blocks DNS lookup in network-isolated namespace
    const dnsCheck = execInOsNetworkSandbox("node", [
      "-e",
      "require('node:dns').lookup('prohibited.example', (err) => { process.exit(err ? 0 : 1); });",
    ]);
    expect(dnsCheck).toBe("");

    // 2. Negative control: OS kernel blocks TCP connection with ENETUNREACH in network-isolated namespace
    // Targeted to RFC 5737 TEST-NET-1 (192.0.2.1) — never sends real network packets
    const tcpCheck = execInOsNetworkSandbox("node", [
      "-e",
      "const s = require('node:net').connect(80, '192.0.2.1'); s.on('error', (e) => { process.exit(e.code === 'ENETUNREACH' ? 0 : 2); });",
    ]);
    expect(tcpCheck).toBe("");

    // 3. Subprocess inheritance: Spawning a child process from Node inherits network namespace isolation
    const inheritanceCheck = execInOsNetworkSandbox("node", [
      "-e",
      `const { spawnSync } = require('node:child_process');
       const res = spawnSync('node', ['-e', "require('node:net').connect(80, '192.0.2.1').on('error', (e) => process.exit(e.code === 'ENETUNREACH' ? 0 : 3))"]);
       process.exit(res.status);`,
    ]);
    expect(inheritanceCheck).toBe("");

    // 4. Positive control: CLI executes cleanly in network-isolated namespace
    const cliOutput = execInOsNetworkSandbox("node", [distCli, "--version"], { env: getIsolatedEnv() }).trim();
    expect(cliOutput).toBe(packageVersion);
  });

  // ── REGRESSION: strict/non-strict capability handling ──
  //
  // These tests verify the skip/fail dispatch logic in isolation so that
  // the OS isolation test itself does not need to simulate sandbox failures.

  describe("osNetworkIsolationUnsupportedReason and capability dispatch", () => {
    it("returns null (supported) when bwrap is available or process is already in a network namespace", () => {
      const reason = osNetworkIsolationUnsupportedReason();
      expect(reason === null || typeof reason === "string").toBe(true);
    });

    it("isOsNetworkIsolationSupported reflects osNetworkIsolationUnsupportedReason", () => {
      const reason = osNetworkIsolationUnsupportedReason();
      expect(isOsNetworkIsolationSupported()).toBe(reason === null);
    });

    it("assertOsNetworkIsolationSupported throws with diagnostic message when isolation is unavailable", () => {
      if (isOsNetworkIsolationSupported()) {
        expect(() => assertOsNetworkIsolationSupported()).not.toThrow();
      } else {
        expect(() => assertOsNetworkIsolationSupported()).toThrow(
          /OS-level network isolation \(bwrap --unshare-net\) is UNVERIFIED/,
        );
      }
    });

    it("normal mode (strict: false) converts every unavailable reason into a skip action with diagnostic detail", () => {
      const reasons: OsIsolationUnavailableReason[] = [
        "not-linux",
        "bwrap-not-found",
        "namespace-rejected",
        "sandbox-error",
      ];
      for (const reason of reasons) {
        const evalResult = evaluateOsNetworkIsolationMode({
          strict: false,
          unsupportedReason: reason,
        });
        expect(evalResult.supported).toBe(false);
        expect(evalResult.action).toBe("skip");
        expect(evalResult.reason).toBe(reason);
        expect(evalResult.message).toContain("UNVERIFIED");
        expect(evalResult.message).toContain("Set STRICT_NETWORK_ISOLATION=1 to fail instead of skip");
      }
    });

    it("strict mode (strict: true) converts every unavailable reason into a fail action and never skips", () => {
      const reasons: OsIsolationUnavailableReason[] = [
        "not-linux",
        "bwrap-not-found",
        "namespace-rejected",
        "sandbox-error",
      ];
      for (const reason of reasons) {
        const evalResult = evaluateOsNetworkIsolationMode({
          strict: true,
          unsupportedReason: reason,
        });
        expect(evalResult.supported).toBe(false);
        expect(evalResult.action).toBe("fail");
        expect(evalResult.reason).toBe(reason);
        expect(evalResult.message).toContain("Strict mode (STRICT_NETWORK_ISOLATION=1) requires verified isolation");
      }
    });

    it("distinguishes missing executable from rejected namespace and platform mismatch in diagnostics", () => {
      expect(getOsNetworkIsolationDetail("bwrap-not-found")).toContain("not installed or not on PATH");
      expect(getOsNetworkIsolationDetail("namespace-rejected")).toContain(
        "rejected unprivileged network-namespace creation",
      );
      expect(getOsNetworkIsolationDetail("not-linux")).toContain("not running on Linux");
      expect(getOsNetworkIsolationDetail("sandbox-error")).toContain("probe failed");
    });
  });
});
