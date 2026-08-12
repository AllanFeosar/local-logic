import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js'
import {
  EMBEDDING_PREFILTER_TOP_K,
  memoryEmbeddingText,
} from './embeddingPreFilter.js'
import type { MemoryHeader } from './memoryScan.js'

/**
 * Second-stage precision pass over the candidates `preFilterMemoriesByEmbedding`
 * already narrowed down: embeddings answer "is this roughly on-topic?" cheaply
 * but crudely (cosine similarity over a short filename+description string);
 * Qwen3-Reranker-0.6B answers "does this specific document actually satisfy
 * this specific query?" per-candidate, which is a meaningfully sharper signal
 * before spending a Sonnet call on final selection. This never replaces
 * selectRelevantMemories, only narrows its input further — same relationship
 * the embedding pre-filter has to it.
 *
 * Scoring approach: Qwen3-Reranker is a pointwise yes/no judge (see its
 * model card's `<Instruct>`/`<Query>`/`<Document>` prompt format). The
 * reference implementation scores candidates via the *logprobs* of the
 * "yes"/"no" tokens, softmax-normalized against each other — not the raw
 * generated text. Ollama's `/api/generate` (checked live against v0.32.8)
 * does expose `logprobs`/`top_logprobs` on the single generated token, so
 * this implements the real logprob-based score rather than falling back to
 * asking the model for a numeric rating: request exactly one output token
 * with a wide `top_logprobs`, then read the yes/no candidates' logprobs back
 * out of that list. `raw: true` is used so we supply the entire chat-template
 * prompt ourselves — this sidesteps Ollama's own Qwen3 template entirely,
 * including the `/think`-suffix quirk documented in openaiShim.ts, since
 * there's no template auto-injection to trigger in raw mode.
 *
 * Fails open, same discipline as the embedding pre-filter: if the reranker
 * is unavailable (Ollama down, model not pulled, timeout, every judgment
 * call erroring), returns the input list unchanged rather than throwing.
 */

const OLLAMA_GENERATE_URL =
  process.env.MEMORY_RERANK_URL ?? 'http://127.0.0.1:11434/api/generate'
const RERANK_MODEL =
  process.env.MEMORY_RERANK_MODEL ??
  'hf.co/QuantFactory/Qwen3-Reranker-0.6B-GGUF:Q4_K_M'

// Measured ~1.5s wall time for 20 concurrent single-token judgment calls
// against a warm model in this project's own live testing (individual calls
// ranged ~0.8-1.5s once queued behind each other server-side); generous
// margin over that for a cold model load (~200ms observed separately) or a
// slower run.
const RERANK_TIMEOUT_MS = 15_000

// Wide enough that both casings of "yes"/"no" ("yes"/"Yes"/"no"/"No" etc.)
// reliably showed up in live testing — this is fundamentally a binary
// judgment the prompt primes the model for, so the true answer token is
// never far from the top.
const RERANK_TOP_LOGPROBS = 20

// Reranking is one Ollama completion call per candidate (no batch-generate
// endpoint exists, unlike /api/embed). It's only meant to run on what the
// embedding pre-filter already narrowed things to (EMBEDDING_PREFILTER_TOP_K
// candidates in the normal path). If the pre-filter itself failed open and
// handed back a much larger unfiltered manifest, firing one reranker call
// per file would be slow and, since both stages hit the same local Ollama
// instance, likely doomed anyway. Bail out (fail open) rather than attempt
// it.
const RERANK_MAX_CANDIDATES = EMBEDDING_PREFILTER_TOP_K

// Sonnet's own selection step (selectRelevantMemories) only ever picks up to
// 5 memories. 10 gives it a candidate list with real room to exercise
// judgment (reranker score isn't a substitute for Sonnet's reasoning about
// the actual query) while still meaningfully shrinking the embedding
// pre-filter's top-20 output before it hits that prompt.
export const RERANK_TOP_N = 10

const RERANK_SYSTEM_PROMPT = `Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".`

const RERANK_INSTRUCT = `Given a user's query to a coding assistant, determine whether this memory note is relevant context for answering it`

function buildPrompt(query: string, document: string): string {
  return (
    `<|im_start|>system\n${RERANK_SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n<Instruct>: ${RERANK_INSTRUCT}\n<Query>: ${query}\n<Document>: ${document}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`
  )
}

type OllamaGenerateResponse = {
  logprobs?: Array<{
    top_logprobs?: Array<{ token?: string; logprob?: number }>
  }>
}

function logSumExp(a: number, b: number): number {
  if (a === -Infinity) return b
  if (b === -Infinity) return a
  const max = Math.max(a, b)
  return max + Math.log(Math.exp(a - max) + Math.exp(b - max))
}

/**
 * Softmax-normalizes P(yes) against P(no) among the candidate tokens Ollama
 * reported for the model's single judgment token — the same normalization
 * the Qwen3-Reranker reference scoring uses. Casing variants ("yes"/"Yes"/
 * "YES") are combined via logsumexp rather than picking one exact token,
 * since live testing showed the model's casing varies with context and
 * arbitrarily picking one would throw away real probability mass.
 *
 * Returns null if neither a yes- nor no-shaped token appears among the
 * requested top candidates. Rare in practice — this is a binary judgment the
 * prompt primes the model for — but callers must treat this as "no signal"
 * for this one candidate, not as a reason to fail the whole rerank.
 */
function scoreFromTopLogprobs(
  topLogprobs: Array<{ token?: string; logprob?: number }>,
): number | null {
  let yes = -Infinity
  let no = -Infinity
  for (const candidate of topLogprobs) {
    if (typeof candidate.token !== 'string' || typeof candidate.logprob !== 'number') {
      continue
    }
    const normalized = candidate.token.trim().toLowerCase()
    if (normalized === 'yes') yes = logSumExp(yes, candidate.logprob)
    else if (normalized === 'no') no = logSumExp(no, candidate.logprob)
  }
  if (yes === -Infinity && no === -Infinity) return null

  const yesProb = yes === -Infinity ? 0 : Math.exp(yes)
  const noProb = no === -Infinity ? 0 : Math.exp(no)
  const total = yesProb + noProb
  return total === 0 ? 0 : yesProb / total
}

async function scoreOne(
  query: string,
  document: string,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetch(OLLAMA_GENERATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: RERANK_MODEL,
        prompt: buildPrompt(query, document),
        raw: true,
        stream: false,
        options: { num_predict: 1, temperature: 0 },
        logprobs: true,
        top_logprobs: RERANK_TOP_LOGPROBS,
      }),
      signal,
    })
    if (!response.ok) return null

    const data = (await response.json()) as OllamaGenerateResponse
    const topLogprobs = data.logprobs?.[0]?.top_logprobs
    if (!Array.isArray(topLogprobs)) return null
    return scoreFromTopLogprobs(topLogprobs)
  } catch {
    return null
  }
}

export async function rerankMemoriesByRelevance(
  query: string,
  candidates: readonly MemoryHeader[],
  signal: AbortSignal,
  topN: number = RERANK_TOP_N,
): Promise<MemoryHeader[]> {
  if (candidates.length <= topN) return [...candidates]
  if (candidates.length > RERANK_MAX_CANDIDATES) return [...candidates]

  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: RERANK_TIMEOUT_MS,
  })

  try {
    const scores = await Promise.all(
      candidates.map(c => scoreOne(query, memoryEmbeddingText(c), combinedSignal)),
    )

    // Every judgment call failed — the reranker is unavailable (Ollama down,
    // model not pulled, everything timed out). Fail open exactly like the
    // embedding pre-filter: don't narrow at all rather than narrow on zero
    // signal.
    if (scores.every(s => s === null)) return [...candidates]

    // Individual failed/no-signal judgments (a single flaky call, a
    // pathological document) fall back to score 0 rather than aborting the
    // whole batch — they sort to the bottom alongside confident "no"
    // judgments instead of losing the rerank's benefit for every other
    // candidate that did score successfully.
    const scored = candidates.map((memory, i) => ({ memory, score: scores[i] ?? 0 }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topN).map(s => s.memory)
  } finally {
    cleanup()
  }
}
