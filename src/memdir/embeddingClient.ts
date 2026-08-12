import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js'

/**
 * Shared low-level client for this project's local all-minilm embedding
 * endpoint (Ollama's `/api/embed`). Extracted out of embeddingPreFilter.ts
 * (2026-08-12) so a second consumer (services/api/toolPreFilter.ts —
 * LOCAL_AI_MASTER_PLAN.md §6 mitigation 3, semantic tool pre-filtering) can
 * reuse the exact same model/endpoint/timeout/fail-open behavior instead of
 * a parallel reimplementation, per that plan's own instruction to reuse
 * "the same all-minilm infrastructure already proven in
 * memdir/embeddingPreFilter.ts". Behavior is unchanged by this extraction —
 * embeddingPreFilter.ts's exported surface (preFilterMemoriesByEmbedding,
 * EMBEDDING_PREFILTER_THRESHOLD/TOP_K, memoryEmbeddingText) and its tests
 * are untouched; only the private embed-call plumbing moved here.
 *
 * Env var names are kept as MEMORY_EMBEDDING_* for backward compatibility
 * with existing configuration (this predates the second consumer) even
 * though they're no longer memory-retrieval-specific.
 */

const OLLAMA_EMBED_URL =
  process.env.MEMORY_EMBEDDING_URL ?? 'http://127.0.0.1:11434/api/embed'
const EMBEDDING_MODEL = process.env.MEMORY_EMBEDDING_MODEL ?? 'all-minilm'

// Measured ~8.5s for a 22-text batch embed call in this project's own
// earlier testing — generous margin over that for larger batches.
export const EMBEDDING_TIMEOUT_MS = 20_000

/**
 * Embeds a batch of texts via Ollama's /api/embed. Returns null (never
 * throws) on any failure — unreachable Ollama, model not pulled, timeout,
 * non-OK response, or a malformed body. Callers are responsible for their
 * own fail-open behavior on a null/short result; this function only
 * reports "the embed call didn't produce a usable result", it doesn't
 * decide what a caller should do about that.
 */
export async function embedTexts(
  texts: string[],
  signal: AbortSignal,
  timeoutMs: number = EMBEDDING_TIMEOUT_MS,
): Promise<number[][] | null> {
  if (texts.length === 0) return []

  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs,
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

export function cosineSimilarity(a: number[], b: number[]): number {
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
