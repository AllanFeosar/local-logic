import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js'
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
 */

const OLLAMA_EMBED_URL =
  process.env.MEMORY_EMBEDDING_URL ?? 'http://127.0.0.1:11434/api/embed'
const EMBEDDING_MODEL = process.env.MEMORY_EMBEDDING_MODEL ?? 'all-minilm'

// Measured ~8.5s for a 22-text batch embed call in this project's own
// earlier testing — generous margin over that for larger memory dirs.
const EMBEDDING_TIMEOUT_MS = 20_000

export const EMBEDDING_PREFILTER_THRESHOLD = 15
export const EMBEDDING_PREFILTER_TOP_K = 20

async function embedBatch(
  texts: string[],
  signal: AbortSignal,
): Promise<number[][] | null> {
  if (texts.length === 0) return []

  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: EMBEDDING_TIMEOUT_MS,
  })

  try {
    const response = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
      signal: combinedSignal,
    })
    if (!response.ok) return null

    const data = (await response.json()) as { embeddings?: unknown }
    if (!Array.isArray(data.embeddings)) return null
    return data.embeddings as number[][]
  } catch {
    return null
  } finally {
    cleanup()
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

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
  const embeddings = await embedBatch(texts, signal)
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
