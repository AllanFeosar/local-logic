import {
  type Candidate,
  DEEP_MODE_DEFAULT_N,
  DEEP_MODE_MAX_N,
  DEEP_MODE_TEMPERATURES,
  generateCandidate,
  generateRetryCandidate,
} from './generateCandidates.js'
import { pickWinner, scoreCandidatesWithReranker } from './rerankCandidates.js'
import { verifyAnswer, type VerificationResult } from './verification.js'

/**
 * §11's full generate → verify → search pipeline, orchestrated:
 *
 * 1. Generate candidates one at a time (not all upfront) at increasing
 *    temperature, verifying each immediately after it's produced.
 * 2. The moment a candidate's verification snippet provably passes (accepted
 *    by the Tier 1 restricted grammar and genuinely evaluated to `True` —
 *    see verification.ts/restrictedEvaluator.ts), return it immediately —
 *    this is the "early-exit" the plan specifies, and it also means the
 *    common case (an easy problem the model gets right on the first try)
 *    never pays for the remaining N-1 candidates at all.
 * 3. If nothing passes after N candidates: candidates verification could
 *    not adjudicate (no snippet, rejected, crashed, timed out — never a
 *    provable failure) are scored by Qwen3-Reranker; self-consistency only
 *    breaks ties or acts as a last-resort fallback if the reranker itself
 *    gave zero signal — never the primary decision, matching §11's explicit
 *    "verify, don't vote" framing.
 * 4. Only if EVERY candidate was provably wrong (zero inconclusive
 *    survivors — see the note in the loop below) does this escalate: one
 *    bounded retry, re-prompted with the failures + verifier feedback. Not
 *    more candidates, not an open-ended loop.
 */

export type DeepSolveMethod =
  | 'code-verified'
  | 'reranker-scored'
  | 'self-consistency'
  | 'best-effort-unverified'

export type DeepSolveResult = {
  answer: string
  /** True only when a candidate provably passed its own executed check. */
  verified: boolean
  method: DeepSolveMethod
  candidatesGenerated: number
  candidatesPassed: number
  candidatesFailed: number
  candidatesInconclusive: number
  retried: boolean
  truncated: boolean
  durationMs: number
}

export type DeepSolveOptions = {
  /** Defaults to DEEP_MODE_DEFAULT_N; hard-capped at DEEP_MODE_TEMPERATURES.length regardless of what's requested. */
  n?: number
}

function buildResult(
  candidate: Candidate,
  verified: boolean,
  method: DeepSolveMethod,
  stats: {
    candidatesGenerated: number
    candidatesPassed: number
    candidatesFailed: number
    candidatesInconclusive: number
    retried: boolean
  },
  start: number,
): DeepSolveResult {
  return {
    answer: candidate.answer,
    verified,
    method,
    ...stats,
    truncated: candidate.truncated,
    durationMs: Date.now() - start,
  }
}

export async function solveDeep(
  problem: string,
  signal: AbortSignal,
  options: DeepSolveOptions = {},
): Promise<DeepSolveResult> {
  const start = Date.now()
  const n = Math.max(1, Math.min(options.n ?? DEEP_MODE_DEFAULT_N, DEEP_MODE_MAX_N))
  const temperatures = DEEP_MODE_TEMPERATURES.slice(0, n)

  const all: Candidate[] = []
  const failed: Array<{ candidate: Candidate; verification: VerificationResult }> = []
  const inconclusive: Array<{ candidate: Candidate; verification: VerificationResult }> = []

  for (let i = 0; i < temperatures.length; i++) {
    if (signal.aborted) break

    const candidate = await generateCandidate(problem, temperatures[i]!, i, signal)
    all.push(candidate)

    const verification = await verifyAnswer(candidate.answer, { signal })

    if (verification.outcome === 'pass') {
      return buildResult(
        candidate,
        true,
        'code-verified',
        {
          candidatesGenerated: all.length,
          candidatesPassed: 1,
          candidatesFailed: failed.length,
          candidatesInconclusive: inconclusive.length,
          retried: false,
        },
        start,
      )
    }
    if (verification.outcome === 'fail') {
      failed.push({ candidate, verification })
    } else {
      inconclusive.push({ candidate, verification })
    }
  }

  const baseStats = {
    candidatesGenerated: all.length,
    candidatesPassed: 0,
    candidatesFailed: failed.length,
    candidatesInconclusive: inconclusive.length,
  }

  // Step 3: score what code couldn't adjudicate. Only candidates verification
  // left as "inconclusive" are eligible — a candidate whose own check
  // provably found it wrong is excluded from scoring/voting entirely (never
  // resurrected by a good-sounding reranker judgment).
  if (inconclusive.length > 0) {
    const scored = await scoreCandidatesWithReranker(
      problem,
      inconclusive.map(x => x.candidate),
      signal,
    )
    const { winner, method } = pickWinner(scored)
    return buildResult(winner, false, method, { ...baseStats, retried: false }, start)
  }

  // Nothing survived to be scored: every single candidate was provably
  // wrong. Step 4: exactly one bounded retry with feedback, never more
  // width.
  if (failed.length > 0) {
    const retryCandidate = await generateRetryCandidate(
      problem,
      failed.map(f => ({ answer: f.candidate.answer, verifierDetail: f.verification.detail })),
      all.length,
      signal,
    )
    all.push(retryCandidate)
    const retryVerification = await verifyAnswer(retryCandidate.answer, { signal })

    if (retryVerification.outcome === 'pass') {
      return buildResult(
        retryCandidate,
        true,
        'code-verified',
        { ...baseStats, candidatesGenerated: all.length, candidatesPassed: 1, retried: true },
        start,
      )
    }

    // Retry didn't pass either. Best-effort: prefer the retry candidate (the
    // freshest attempt, the only one that saw the prior failures as
    // feedback) over blindly picking among the originally-failed pool.
    const updatedFailedCount =
      retryVerification.outcome === 'fail' ? failed.length + 1 : failed.length
    const updatedInconclusiveCount =
      retryVerification.outcome === 'inconclusive' ? inconclusive.length + 1 : inconclusive.length
    return buildResult(
      retryCandidate,
      false,
      'best-effort-unverified',
      {
        candidatesGenerated: all.length,
        candidatesPassed: 0,
        candidatesFailed: updatedFailedCount,
        candidatesInconclusive: updatedInconclusiveCount,
        retried: true,
      },
      start,
    )
  }

  // Structurally unreachable (n >= 1 always produces at least one candidate,
  // which lands in exactly one of pass/fail/inconclusive) — kept as an
  // explicit, honest error rather than silently returning something instead
  // of ever reaching here.
  throw new Error('DeepSolve: no candidate produced any usable result')
}
