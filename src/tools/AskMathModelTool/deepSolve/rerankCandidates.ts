import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import { scoreYesNoJudgment } from '../../../memdir/rerank.js'
import type { Candidate } from './generateCandidates.js'

/**
 * §11 pipeline step 3: Qwen3-Reranker as a learned scorer over candidates
 * deterministic verification couldn't adjudicate — the same yes/no-logprob
 * mechanism `src/memdir/rerank.ts` already implements and tests
 * (`scoreYesNoJudgment`, reused directly, not reimplemented): same model,
 * same `raw: true` Ollama prompt-template-bypass technique, same softmax
 * scoring math. Only the `instruct`/`query`/`document` content differs.
 */

const MATH_RERANK_INSTRUCT = `Given a math or logic problem and a candidate final answer with its reasoning, determine whether the final answer is correct and the reasoning is valid for this specific problem`

// Candidate answers can run considerably longer than the short
// filename+description documents memdir's rerank.ts scores, so this uses a
// more generous timeout than RERANK_TIMEOUT_MS there (still one Ollama call
// per candidate, num_predict=1 regardless of prompt length — dominated by
// prefill time, not generation).
const MATH_RERANK_TIMEOUT_MS = 30_000

export type ScoredCandidate = {
  candidate: Candidate
  /** null = no signal for this candidate (call failed/timed out/malformed). */
  score: number | null
}

export async function scoreCandidatesWithReranker(
  problem: string,
  candidates: readonly Candidate[],
  signal: AbortSignal,
): Promise<ScoredCandidate[]> {
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: MATH_RERANK_TIMEOUT_MS,
  })
  try {
    const scores = await Promise.all(
      candidates.map(c => scoreYesNoJudgment(MATH_RERANK_INSTRUCT, problem, c.answer, combinedSignal)),
    )
    return candidates.map((candidate, i) => ({ candidate, score: scores[i] ?? null }))
  } finally {
    cleanup()
  }
}

const TIE_EPSILON = 0.02

function normalizeAnswerForVote(answer: string): string {
  return answer
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Self-consistency vote (§11: "only a final tie-break among already-
 * verified candidates, never the primary decision"). Groups candidates by a
 * light normalization of their final-answer text and returns the first
 * (lowest-index, i.e. lowest-temperature / most-deterministic) candidate
 * from the largest group — a deterministic tie-break, not a debate.
 *
 * Honestly weak as a *general* voting mechanism (free-form answer phrasing
 * rarely matches exactly across candidates, so groups are often all size 1,
 * degenerating to "pick candidate 0") — that's fine here because it is
 * never the primary signal: the reranker score decides in the overwhelming
 * majority of real runs, this only breaks ties or acts as a last-resort
 * fallback when the reranker itself returned zero signal for everything.
 */
export function selfConsistencyVote(candidates: readonly Candidate[]): Candidate {
  const groups = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const key = normalizeAnswerForVote(c.answer)
    const list = groups.get(key) ?? []
    list.push(c)
    groups.set(key, list)
  }
  let best = candidates[0]!
  let bestSize = 0
  for (const list of groups.values()) {
    if (list.length > bestSize) {
      bestSize = list.length
      best = list[0]!
    }
  }
  return best
}

/**
 * Picks the winning candidate among the reranker-scored survivors. If the
 * top score is a clear outright winner, returns it directly. If multiple
 * candidates tie within TIE_EPSILON at the top, breaks the tie via
 * selfConsistencyVote among just that tied top tier (never among the whole
 * pool, and never among candidates verification already ruled provably
 * wrong — those are excluded by the caller before this is invoked). If the
 * reranker produced no signal at all (every score null — Ollama down, model
 * unavailable, everything timed out), falls back to a pure self-consistency
 * vote across all survivors as the best remaining option.
 */
export function pickWinner(scored: readonly ScoredCandidate[]): {
  winner: Candidate
  method: 'reranker-scored' | 'self-consistency'
} {
  const withScore = scored.filter((s): s is { candidate: Candidate; score: number } => s.score !== null)
  if (withScore.length === 0) {
    return { winner: selfConsistencyVote(scored.map(s => s.candidate)), method: 'self-consistency' }
  }

  const maxScore = Math.max(...withScore.map(s => s.score))
  const topTier = withScore.filter(s => maxScore - s.score < TIE_EPSILON)
  if (topTier.length === 1) {
    return { winner: topTier[0]!.candidate, method: 'reranker-scored' }
  }
  return {
    winner: selfConsistencyVote(topTier.map(s => s.candidate)),
    method: 'reranker-scored',
  }
}
