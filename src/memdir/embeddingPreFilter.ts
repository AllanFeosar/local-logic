import { cosineSimilarity, embedTexts } from './embeddingClient.js'
import type { MemoryHeader } from './memoryScan.js'

/**
 * Narrows a large memory manifest down to the topK most semantically
 * similar to the query, via local all-minilm embeddings + cosine
 * similarity, before handing off to Sonnet (selectRelevantMemories) for
 * final selection. Sonnet already reasons well over a small manifest — this
 * pre-filter only earns its extra network round trip once the full
 * manifest would otherwise be unwieldy (see EMBEDDING_PREFILTER_THRESHOLD),
 * and it never replaces the Sonnet selection step, only narrows its input.
 *
 * Fails open: if embedding is unavailable for any reason (Ollama not
 * running, all-minilm not pulled, timeout, malformed response), returns the
 * full `memories` list unchanged rather than throwing — memory retrieval
 * must degrade gracefully, not break, when the local embedding model isn't
 * up.
 *
 * The actual embed-endpoint call lives in ./embeddingClient.js, shared with
 * services/api/toolPreFilter.ts (semantic tool pre-filtering) — see that
 * file's own comment.
 */

export const EMBEDDING_PREFILTER_THRESHOLD = 15
export const EMBEDDING_PREFILTER_TOP_K = 20

// Exported so rerank.ts can score the same filename+description text it was
// embedded with — keeping both retrieval stages' notion of "what a memory
// looks like to a relevance model" in one place instead of two drifting copies.
export function memoryEmbeddingText(m: MemoryHeader): string {
  return m.description ? `${m.filename}: ${m.description}` : m.filename
}

export async function preFilterMemoriesByEmbedding(
  query: string,
  memories: readonly MemoryHeader[],
  signal: AbortSignal,
  topK: number = EMBEDDING_PREFILTER_TOP_K,
): Promise<MemoryHeader[]> {
  if (memories.length <= topK) return [...memories]

  const texts = [query, ...memories.map(memoryEmbeddingText)]
  const embeddings = await embedTexts(texts, signal)
  if (!embeddings || embeddings.length !== texts.length) {
    // Embedding unavailable or malformed — fail open, let the caller fall
    // back to sending the full manifest to Sonnet.
    return [...memories]
  }

  const [queryEmbedding, ...memoryEmbeddings] = embeddings as [
    number[],
    ...number[][],
  ]
  const scored = memories.map((m, i) => ({
    memory: m,
    score: cosineSimilarity(queryEmbedding, memoryEmbeddings[i]!),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map(s => s.memory)
}
