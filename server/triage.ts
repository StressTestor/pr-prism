import { isBotAuthor } from "../src/bots.js";
import { selectCanonical } from "../src/canonical.js";
import { createEmbeddingProvider, prepareEmbeddingText } from "../src/embeddings.js";
import type { ItemMetadata } from "../src/metadata.js";
import { cosineSimilarity, isZeroVector } from "../src/similarity.js";
import type { StoreItem } from "../src/types.js";
import { isRepoScanning, openRepoDB, queueWebhook } from "./db.js";
import type { DupeMatch } from "./format.js";
import { formatAutoCloseComment, formatTriageComment } from "./format.js";
import type { OwnerSuggestion } from "./routing.js";
import { suggestOwners } from "./routing.js";
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
  /** This repo's `cluster` block. Absent means the built-in bot list only. */
  cluster?: { includeBotAuthors: boolean; botAuthors: string[] };
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

  const botLogins = new Set(config.cluster?.botAuthors ?? []);
  const includeBots = config.cluster?.includeBotAuthors ?? false;

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
    const id = `${repo}:${itemType}:${event.number}`;

    // A webhook knows only what the event carries. Everything else an item has
    // (labels, diff size, CI, closing refs) comes from a scan, so only the
    // event's own fields are written and the rest of the stored row is left
    // alone: upsert replaces metadata_json wholesale, and a webhook arriving
    // after a backlog scan would otherwise drop everything that scan learned.
    const existing = (store.getItem(id)?.metadata ?? {}) as Record<string, unknown>;
    // Only the fields the event can observe. Typed as a subset of what
    // itemMetadata produces, so a rename there breaks the build here rather
    // than silently writing a key nothing reads. A field the webhook cannot
    // see is left as stored: `labels: []` would claim the item has none rather
    // than that the webhook did not look.
    const observed: Partial<ItemMetadata> = {
      author: event.sender,
      state: "open",
      bodyLength: (event.body || "").length,
    };
    const metadata: Record<string, unknown> = { ...existing, ...observed };

    const storeItem: StoreItem = {
      id,
      type: itemType,
      number: event.number,
      repo,
      title: event.title,
      bodySnippet: (event.body || "").slice(0, 2000),
      embedding,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
    store.upsert(storeItem);

    // Automation reuses titles for unrelated content, so consecutive bot items
    // read as near-identical. Clustering already excludes them; commenting
    // "this looks like a duplicate" on a bot's PR is that same noise, posted to
    // someone's repository.
    //
    // Deliberately after the upsert, not before it. The backlog scan stores
    // every item and filters at cluster time, so bailing earlier would make the
    // database depend on which path saw the item, and flipping
    // includeBotAuthors on would need a full rescan to become true. The cost is
    // one embedding per bot item, which the scan path pays anyway.
    if (!includeBots && isBotAuthor({ author: event.sender }, botLogins)) {
      empty.elapsedMs = performance.now() - start;
      return empty;
    }

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
        // Same rule on the other side: a bot's PR is not a useful "you
        // duplicated this" answer for a human contributor.
        if (
          !includeBots &&
          isBotAuthor(
            {
              author: (item.metadata?.author as string) ?? "",
              authorIsBot: item.metadata?.authorIsBot as boolean | undefined,
            },
            botLogins,
          )
        ) {
          continue;
        }

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

    // pick source of truth via the shared selector. DupeMatch has no quality
    // score, so similarity stands in as the score; `mode: itemType` pins the rule
    // to the incoming item's type (issue -> earliest, PR -> highest similarity),
    // same rule as before. One deliberate change: exact ties (same createdAt /
    // same similarity) now resolve by score then lowest item number instead of
    // first-seen match order, so repeat runs name the same canonical.
    const source: DupeMatch = selectCanonical(
      matches.map((m) => ({ ...m, score: m.similarity })),
      { mode: itemType },
    );

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
    if (config.autoClose && closeIssue && matches[0].similarity >= config.autoCloseThreshold) {
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
