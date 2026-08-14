import {
  type Candidate,
  DEEP_MODE_DEFAULT_N,
  DEEP_MODE_MAX_N,
  DEEP_MODE_TEMPERATURES,
  generateCandidate,
  generateRetryCandidate,
} from './generateCandidates.js'
import { logForDebugging } from '../../../utils/debug.js'
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
  // Session 29: a candidate that fails to GENERATE at all (network error,
  // or the MATH_MODEL_TIMEOUT_MS abort — see that constant's own comment
  // for why this is a real, observed case, not a hypothetical) used to
  // propagate straight out of this function uncaught, crashing the entire
  // solve and discarding every candidate generated so far — even ones that
  // already passed. Counted separately from `failed` (a provable wrong
  // answer) because there is no real candidate/answer content here to
  // score or feed into a retry prompt; it only affects whether the loop
  // keeps trying more temperatures and the final generatedCount/error path.
  let generationFailures = 0

  for (let i = 0; i < temperatures.length; i++) {
    if (signal.aborted) break

    let candidate: Candidate
    try {
      candidate = await generateCandidate(problem, temperatures[i]!, i, signal)
    } catch (error) {
      generationFailures++
      // Security-audit finding (session 29, LOW): log what was actually
      // caught rather than silently discarding it — a genuine bug inside
      // generateCandidate would otherwise be indistinguishable from the
      // expected timeout/network-failure case, narrowing the search with
      // no visible signal. Distinguish an intentional abort (the timeout
      // this resilience exists for) from anything else, which is worth a
      // caller's attention even though this loop recovers from it either way.
      const isAbort = error instanceof Error && error.name === 'AbortError'
      logForDebugging(
        `[solveDeep] candidate ${i} (temp=${temperatures[i]}) failed to generate` +
          `${isAbort ? ' (timed out)' : ''}: ${error instanceof Error ? error.message : String(error)}`,
      )
      // Try the next temperature in the schedule rather than losing every
      // candidate generated so far to one slow/failed attempt — the same
      // "one bad attempt doesn't sink the pipeline" resilience this
      // function already applies to a provably-wrong verification result.
      continue
    }
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

  // Session 29: this WAS structurally unreachable before generation failures
  // were caught above (n >= 1 always produced at least one candidate landing
  // in pass/fail/inconclusive) — it is genuinely reachable now, in exactly
  // one case: every single candidate failed to GENERATE (network error or
  // MATH_MODEL_TIMEOUT_MS elapsed on all of them), so `all`, `failed`, and
  // `inconclusive` are all empty. Distinguished from the truly-unreachable
  // case with its own message so a caller can tell "the math specialist was
  // unreachable/too slow every attempt" apart from "it answered every time
  // but this function still has a real logic gap" — the latter would be a
  // genuine bug report, the former is an infrastructure/timeout condition.
  if (generationFailures > 0 && all.length === 0) {
    // Security-audit finding (session 29, LOW): report against the actual
    // schedule length, not `generationFailures` against itself (which is
    // always "N/N" by construction and would misreport a run that broke
    // early on an aborted parent signal after only one attempt as if the
    // full schedule had been tried).
    const abortedEarly = generationFailures < temperatures.length
    throw new Error(
      `DeepSolve: ${generationFailures}/${temperatures.length} scheduled candidate(s) failed to generate` +
        `${abortedEarly ? ' (stopped early — parent signal aborted)' : ''} — the math specialist was unreachable or exceeded MATH_MODEL_TIMEOUT_MS, not a verification failure.`,
    )
  }
  throw new Error('DeepSolve: no candidate produced any usable result — this indicates a genuine logic gap in this function, not an expected outcome.')
}
