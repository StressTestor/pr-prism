import { readFileSync } from "node:fs";
import type { PrismConfig } from "./config.js";
import { cosineSimilarity, isZeroVector } from "./similarity.js";
import type { VectorStore } from "./store.js";
import type { EmbeddingProvider, VisionScore } from "./types.js";

interface VisionChunk {
  heading: string;
  text: string;
  embedding: number[];
}

function splitByHeadings(doc: string): Array<{ heading: string; text: string }> {
  const lines = doc.split("\n");
  const sections: Array<{ heading: string; text: string }> = [];
  let currentHeading = "Document Overview";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, text: currentLines.join("\n").trim() });
      }
      currentHeading = headingMatch[1];
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, text: currentLines.join("\n").trim() });
  }

  return sections.filter((s) => s.text.length > 20);
}

export async function loadAndEmbedVisionDoc(docPath: string, embedder: EmbeddingProvider): Promise<VisionChunk[]> {
  const content = readFileSync(docPath, "utf-8");

  // If doc is short (<8K chars ≈ <4K tokens), embed whole doc + sections
  const sections = splitByHeadings(content);

  // Truncate sections to ~6K chars (~3K tokens) to stay within embedding model limits
  const textsToEmbed = sections.map((s) => {
    const text = s.text.slice(0, 6000);
    return `${s.heading}\n\n${text}`;
  });

  // Also embed the entire doc if it's short enough
  if (content.length < 8000) {
    textsToEmbed.unshift(content);
    sections.unshift({ heading: "Full Document", text: content });
  }

  // Embed in small batches to avoid token limits
  const embeddings: number[][] = [];
  for (let i = 0; i < textsToEmbed.length; i += 5) {
    const batch = textsToEmbed.slice(i, i + 5);
    const results = await embedder.embedBatch(batch);
    embeddings.push(...results);
  }

  return sections.map((section, i) => ({
    heading: section.heading,
    text: section.text,
    embedding: embeddings[i],
  }));
}

export function scoreVisionAlignment(
  prEmbedding: number[],
  visionChunks: VisionChunk[],
  config: PrismConfig,
): VisionScore {
  let maxSim = 0;
  let matchedSection = "";

  for (const chunk of visionChunks) {
    const sim = cosineSimilarity(prEmbedding, chunk.embedding);
    if (sim > maxSim) {
      maxSim = sim;
      matchedSection = chunk.heading;
    }
  }

  const thresholds = config.thresholds;
  let classification: VisionScore["classification"];
  if (maxSim >= thresholds.aligned) {
    classification = "aligned";
  } else if (maxSim >= thresholds.drifting) {
    classification = "drifting";
  } else {
    classification = "off-vision";
  }

  return {
    prNumber: 0, // Caller fills this in
    score: maxSim,
    classification,
    matchedSection,
  };
}

export async function checkVisionAlignment(
  store: VectorStore,
  embedder: EmbeddingProvider,
  config: PrismConfig,
  visionDocPath: string,
  repo: string,
): Promise<VisionScore[]> {
  const visionChunks = await loadAndEmbedVisionDoc(visionDocPath, embedder);
  const items = store.getAllItems(repo);
  const results: VisionScore[] = [];

  for (const item of items) {
    const emb = store.getEmbedding(item.id);
    if (!emb || isZeroVector(emb)) continue;

    const prEmbedding = Array.from(emb);
    const score = scoreVisionAlignment(prEmbedding, visionChunks, config);
    score.prNumber = item.number;
    results.push(score);
  }

  return results.sort((a, b) => b.score - a.score);
}
