import { createEmbeddingProvider, prepareEmbeddingText } from "../src/embeddings.js";
import { cosineSimilarity, isZeroVector } from "../src/similarity.js";
import type { StoreItem } from "../src/types.js";
import { isRepoScanning, openRepoDB, queueWebhook } from "./db.js";
import { formatAutoCloseComment, formatTriageComment } from "./format.js";
import type { DupeMatch } from "./format.js";
import { suggestOwners } from "./routing.js";
import type { OwnerSuggestion } from "./routing.js";
import type { WebhookEvent } from "./webhook.js";

export type { DupeMatch } from "./format.js";

export interface TriageResult {
  repo: string;
  number: number;
  matches: DupeMatch[];
  source: DupeMatch | null;
  commented: boolean;
  closed: boolean;
  elapsedMs: number;
}

export interface TriageConfig {
  dataDir: string;
  jinaApiKey: string;
  similarityThreshold: number;
  autoClose: boolean;
  autoCloseThreshold: number;
}

export async function triageNewItem(
  event: WebhookEvent,
  config: TriageConfig,
  postComment: (repo: string, number: number, body: string) => Promise<void>,
  closeIssue?: (repo: string, number: number) => Promise<void>,
  fetchFileContent?: (repo: string, path: string) => Promise<string | null>,
): Promise<TriageResult> {
  const start = performance.now();
  const { owner, name: repoName, fullName: repo } = event.repo;

  const empty: TriageResult = {
    repo,
    number: event.number,
    matches: [],
    source: null,
    commented: false,
    closed: false,
    elapsedMs: 0,
  };

  // if repo is still doing its initial backlog scan, queue and bail
  if (isRepoScanning(owner, repoName)) {
    queueWebhook(owner, repoName, event);
    empty.elapsedMs = performance.now() - start;
    return empty;
  }

  // set up embedding provider (Jina)
  const embedder = await createEmbeddingProvider({
    provider: "jina",
    apiKey: config.jinaApiKey,
    model: "jina-embeddings-v3",
  });

  const dims = embedder.dimensions;
  const store = openRepoDB(config.dataDir, owner, repoName, dims, "jina-embeddings-v3");

  try {
    // embed the new item
    const itemType = event.eventType === "pull_request" ? "pr" : "issue";
    const text = prepareEmbeddingText({
      title: event.title,
      body: event.body,
      type: itemType,
    });

    const embeddingArr = await embedder.embed(text);
    const embedding = new Float32Array(embeddingArr);

    if (isZeroVector(embedding)) {
      empty.elapsedMs = performance.now() - start;
      return empty;
    }

    // upsert the new item into the store
    const now = new Date().toISOString();
    const storeItem: StoreItem = {
      id: `${repo}:${itemType}:${event.number}`,
      type: itemType,
      number: event.number,
      repo,
      title: event.title,
      bodySnippet: (event.body || "").slice(0, 2000),
      embedding,
      metadata: { author: event.sender, state: "open" },
      createdAt: now,
      updatedAt: now,
    };
    store.upsert(storeItem);

    // get all existing embeddings and items for this repo
    const allEmbeddings = store.getAllEmbeddings(repo);
    const allItems = store.getAllItems(repo);

    const itemMap = new Map<string, StoreItem>();
    for (const item of allItems) {
      itemMap.set(item.id, item);
    }

    // compute cosine similarity against every other item
    const newId = storeItem.id;
    const matches: DupeMatch[] = [];

    for (const [id, existingEmb] of allEmbeddings) {
      if (id === newId) continue;
      if (isZeroVector(existingEmb)) continue;

      const sim = cosineSimilarity(embedding, existingEmb);
      if (sim >= config.similarityThreshold) {
        const item = itemMap.get(id);
        if (!item) continue;

        matches.push({
          number: item.number,
          type: item.type,
          title: item.title,
          similarity: sim,
          author: item.metadata?.author as string | undefined,
          createdAt: item.createdAt,
        });
      }
    }

    if (matches.length === 0) {
      empty.elapsedMs = performance.now() - start;
      return empty;
    }

    // sort by similarity descending
    matches.sort((a, b) => b.similarity - a.similarity);

    // pick source of truth:
    // for issues -> earliest createdAt among matches
    // for PRs -> highest similarity score (already sorted, so first)
    let source: DupeMatch;
    if (itemType === "issue") {
      source = matches.reduce((earliest, m) => {
        if (!earliest.createdAt) return m;
        if (!m.createdAt) return earliest;
        return m.createdAt < earliest.createdAt ? m : earliest;
      });
    } else {
      source = matches[0];
    }

    const elapsedMs = performance.now() - start;

    // fetch CODEOWNERS and suggest owners
    let owners: OwnerSuggestion[] = [];
    if (fetchFileContent) {
      let codeownersContent: string | null = null;
      // try .github/CODEOWNERS first, then root CODEOWNERS
      codeownersContent = await fetchFileContent(repo, ".github/CODEOWNERS");
      if (!codeownersContent) {
        codeownersContent = await fetchFileContent(repo, "CODEOWNERS");
      }
      if (codeownersContent) {
        owners = suggestOwners(event.title, event.body, codeownersContent);
      }
    }

    // post comment
    const comment = formatTriageComment(repo, matches, source, elapsedMs, owners);
    await postComment(repo, event.number, comment);

    let closed = false;

    // auto-close if enabled and top match exceeds threshold
    if (
      config.autoClose &&
      closeIssue &&
      matches[0].similarity >= config.autoCloseThreshold
    ) {
      const closeComment = formatAutoCloseComment(repo, source, matches[0].similarity);
      await postComment(repo, event.number, closeComment);
      await closeIssue(repo, event.number);
      closed = true;
    }

    return {
      repo,
      number: event.number,
      matches,
      source,
      commented: true,
      closed,
      elapsedMs,
    };
  } finally {
    store.close();
  }
}
