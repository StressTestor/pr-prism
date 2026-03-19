import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookEvent } from "../webhook.js";
import { openRepoDB } from "../db.js";
import { setRepoScanning, isRepoScanning, drainWebhookQueue } from "../db.js";
import { formatTriageComment, formatAutoCloseComment } from "../format.js";
import type { DupeMatch } from "../format.js";

// --- mock createEmbeddingProvider so we never hit a real API ---

// deterministic fake vectors (4 dimensions for testing)
const DIMS = 4;

function fakeVector(seed: number[]): number[] {
  // normalize so cosine similarity behaves predictably
  const mag = Math.sqrt(seed.reduce((s, v) => s + v * v, 0));
  return mag === 0 ? seed : seed.map((v) => v / mag);
}

// two near-identical vectors (high cosine similarity ~0.99+)
const VEC_A = fakeVector([1, 0, 0, 0]);
const VEC_B = fakeVector([0.99, 0.1, 0, 0]);
// orthogonal vector (cosine similarity ~0)
const VEC_UNRELATED = fakeVector([0, 0, 0, 1]);

let mockEmbedResult: number[] = VEC_A;

vi.mock("../../src/embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(async () => ({
    embed: vi.fn(async () => mockEmbedResult),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => mockEmbedResult)),
    dimensions: DIMS,
  })),
  prepareEmbeddingText: vi.fn(
    (item: { title: string; body: string; type: string }) => {
      const prefix = item.type === "pr" ? "Pull Request" : "Issue";
      return `${prefix}: ${item.title}\n\n${item.body}`;
    },
  ),
}));

// --- helpers ---

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    action: "opened",
    eventType: "issues",
    number: 100,
    title: "New bug report",
    body: "Something is broken",
    repo: {
      owner: "octocat",
      name: "my-repo",
      fullName: "octocat/my-repo",
    },
    sender: "contributor",
    ...overrides,
  };
}

function seedItem(
  dataDir: string,
  opts: {
    owner?: string;
    repoName?: string;
    repo?: string;
    number: number;
    type: "pr" | "issue";
    title: string;
    embedding: number[];
    createdAt?: string;
  },
) {
  const owner = opts.owner ?? "octocat";
  const repoName = opts.repoName ?? "my-repo";
  const repo = opts.repo ?? `${owner}/${repoName}`;
  const store = openRepoDB(dataDir, owner, repoName, DIMS, "jina-embeddings-v3");
  store.upsert({
    id: `${repo}:${opts.type}:${opts.number}`,
    type: opts.type,
    number: opts.number,
    repo,
    title: opts.title,
    bodySnippet: "",
    embedding: new Float32Array(opts.embedding),
    metadata: { author: "someone", state: "open" },
    createdAt: opts.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  store.close();
}

// --- tests ---

describe("triageNewItem", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "prism-triage-test-"));
    // reset scanning flags between tests
    setRepoScanning("octocat", "my-repo", false);
    mockEmbedResult = VEC_A;
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  const baseConfig = {
    dataDir: "", // set per-test from beforeEach
    jinaApiKey: "fake-key",
    similarityThreshold: 0.8,
    autoClose: false,
    autoCloseThreshold: 0.95,
  };

  function config() {
    return { ...baseConfig, dataDir };
  }

  it("posts a comment when dupes exist above threshold", async () => {
    // dynamically import so the mock is applied
    const { triageNewItem } = await import("../triage.js");

    // seed an existing item with a very similar vector
    seedItem(dataDir, {
      number: 50,
      type: "issue",
      title: "Original bug",
      embedding: VEC_B,
    });

    const posted: Array<{ repo: string; number: number; body: string }> = [];
    const postComment = async (repo: string, number: number, body: string) => {
      posted.push({ repo, number, body });
    };

    const result = await triageNewItem(makeEvent(), config(), postComment);

    expect(result.commented).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].number).toBe(50);
    expect(result.source).not.toBeNull();
    expect(result.source!.number).toBe(50);
    expect(posted.length).toBe(1);
    expect(posted[0].body).toContain("pr-prism triage");
    expect(posted[0].body).toContain("#50");
    expect(posted[0].number).toBe(100);
  });

  it("does not comment when no dupes above threshold", async () => {
    const { triageNewItem } = await import("../triage.js");

    // seed an existing item with an orthogonal vector (similarity ~0)
    seedItem(dataDir, {
      number: 50,
      type: "issue",
      title: "Unrelated thing",
      embedding: VEC_UNRELATED,
    });

    const posted: unknown[] = [];
    const postComment = async () => {
      posted.push(true);
    };

    const result = await triageNewItem(makeEvent(), config(), postComment);

    expect(result.commented).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it("auto-closes when top match exceeds autoCloseThreshold", async () => {
    const { triageNewItem } = await import("../triage.js");

    // seed with near-identical vector
    seedItem(dataDir, {
      number: 50,
      type: "issue",
      title: "Original bug",
      embedding: VEC_B,
    });

    const posted: Array<{ repo: string; number: number; body: string }> = [];
    const postComment = async (repo: string, number: number, body: string) => {
      posted.push({ repo, number, body });
    };

    const closed: Array<{ repo: string; number: number }> = [];
    const closeIssue = async (repo: string, number: number) => {
      closed.push({ repo, number });
    };

    // set autoClose on with a low threshold that VEC_A vs VEC_B will exceed
    const cfg = {
      ...config(),
      autoClose: true,
      autoCloseThreshold: 0.9,
    };

    const result = await triageNewItem(makeEvent(), cfg, postComment, closeIssue);

    expect(result.closed).toBe(true);
    expect(closed).toHaveLength(1);
    expect(closed[0].number).toBe(100);
    // two comments: triage + auto-close
    expect(posted.length).toBe(2);
    expect(posted[1].body).toContain("closing as duplicate");
  });

  it("does not auto-close when autoClose is disabled", async () => {
    const { triageNewItem } = await import("../triage.js");

    seedItem(dataDir, {
      number: 50,
      type: "issue",
      title: "Original bug",
      embedding: VEC_B,
    });

    const posted: unknown[] = [];
    const postComment = async () => {
      posted.push(true);
    };
    const closed: unknown[] = [];
    const closeIssue = async () => {
      closed.push(true);
    };

    const cfg = {
      ...config(),
      autoClose: false,
      autoCloseThreshold: 0.9,
    };

    const result = await triageNewItem(makeEvent(), cfg, postComment, closeIssue);

    expect(result.commented).toBe(true);
    expect(result.closed).toBe(false);
    expect(closed).toHaveLength(0);
  });

  it("returns early with no comment for empty repo", async () => {
    const { triageNewItem } = await import("../triage.js");

    // no seeded items — repo is empty
    const posted: unknown[] = [];
    const postComment = async () => {
      posted.push(true);
    };

    const result = await triageNewItem(makeEvent(), config(), postComment);

    expect(result.commented).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it("queues event and returns early when repo is scanning", async () => {
    const { triageNewItem } = await import("../triage.js");

    setRepoScanning("octocat", "my-repo", true);

    const posted: unknown[] = [];
    const postComment = async () => {
      posted.push(true);
    };

    const event = makeEvent();
    const result = await triageNewItem(event, config(), postComment);

    expect(result.commented).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(posted).toHaveLength(0);

    // event should be in the queue
    const queued = drainWebhookQueue("octocat", "my-repo");
    expect(queued).toHaveLength(1);
    expect((queued[0] as WebhookEvent).number).toBe(100);

    // cleanup
    setRepoScanning("octocat", "my-repo", false);
  });
});

// --- format tests ---

describe("formatTriageComment", () => {
  it("produces valid markdown with matches table", () => {
    const matches: DupeMatch[] = [
      { number: 1234, type: "issue", title: "Original bug report title", similarity: 0.923 },
      { number: 567, type: "issue", title: "Another related issue", similarity: 0.881 },
    ];
    const source = matches[0];
    const result = formatTriageComment("octocat/my-repo", matches, source, 1234);

    expect(result).toContain("## pr-prism triage");
    expect(result).toContain("92.3%");
    expect(result).toContain("88.1%");
    expect(result).toContain("#1234");
    expect(result).toContain("#567");
    expect(result).toContain("https://github.com/octocat/my-repo/issues/1234");
    expect(result).toContain("source of truth");
    expect(result).toContain("1.2s");
  });
});

describe("formatAutoCloseComment", () => {
  it("produces closing message with similarity", () => {
    const source: DupeMatch = {
      number: 1234,
      type: "issue",
      title: "Original",
      similarity: 0.96,
    };
    const result = formatAutoCloseComment("octocat/my-repo", source, 0.965);

    expect(result).toContain("closing as duplicate");
    expect(result).toContain("#1234");
    expect(result).toContain("96.5%");
    expect(result).toContain("auto-closed by");
  });
});
