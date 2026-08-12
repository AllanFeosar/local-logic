import { evaluateRestrictedCheck } from './restrictedEvaluator.js'

/**
 * Deterministic verification step (§11 pipeline step 2): extracts the
 * restricted-grammar check the specialist model was asked to produce
 * alongside its answer, actually evaluates it locally via the Tier 1
 * restricted AST evaluator (never just "asks about" it — see
 * restrictedEvaluator.ts for how "actually evaluates" is real: a
 * hand-written tree-walking interpreter, never Python's own eval()/exec()),
 * and classifies the outcome into exactly three buckets:
 *
 * - 'pass'         — the check was accepted by the restricted grammar AND
 *                    genuinely evaluated to `True`. Provable, early-exit-worthy.
 * - 'fail'         — the check was accepted by the restricted grammar AND
 *                    genuinely evaluated to `False`. Provable, but note this
 *                    is a *self*-check the same candidate wrote — a real
 *                    signal, not fully independent verification (see
 *                    generateCandidates.ts's prompt for the mitigation: the
 *                    model is instructed to perform a genuine independent
 *                    recomputation, not assert a tautology).
 * - 'inconclusive' — no snippet could be extracted, it was rejected by the
 *                    restricted grammar (e.g. it needs a loop, an import, an
 *                    attribute access, or any other construct outside Tier
 *                    1's allowlist — see restrictedEvaluator.ts's own
 *                    "HONEST LIMITS" section), it evaluated but hit a
 *                    runtime error (undefined variable, division by zero,
 *                    wrong argument count, a magnitude bound), or it timed
 *                    out. This does NOT mean the answer is wrong — only that
 *                    code couldn't adjudicate it, which is exactly the
 *                    bucket §11 step 3 (reranker scoring) exists for.
 *
 * Only 'pass' and 'fail' are provable; 'inconclusive' candidates are never
 * treated as failed for the purposes of solveDeep's escalate-to-retry
 * trigger (see solveDeep.ts).
 *
 * 2026-08-12 (Session 11): this file used to run the extracted snippet
 * through pythonSandbox.ts's runPythonSnippet (arbitrary Python behind a
 * denylist) and read stdout for an exact VERIFIED/FAILED sentinel line.
 * That mechanism is retired — see pythonSandbox.ts's own top-of-file note
 * and LOCAL_AI_MASTER_PLAN.md §11 "Verifier isolation — the settled answer"
 * for why. The "bare print(\"VERIFIED\") forges a pass" concern that used to
 * require a downstream structural heuristic here (hasComparison ||
 * hasNonPrintCall — the 2026-08-12 round-1 security review's Finding 5) is
 * now closed at the grammar level instead, by restrictedEvaluator.ts's
 * `validate_final_shape` requiring the final statement itself be a
 * Compare/BoolOp/Call — so this file no longer needs that heuristic at all.
 */

const FENCE_RE_TAGGED = /```python-verify\s*\n([\s\S]*?)```/i
const FENCE_RE_PLAIN_GLOBAL = /```python\s*\n([\s\S]*?)```/gi

/**
 * Extracts the verification snippet from a candidate's final-answer text.
 * Prefers the explicitly-tagged ```python-verify fence (what candidates are
 * instructed to produce). Falls back to a lone ```python fence only when
 * there is exactly one in the text — with more than one, which snippet is
 * "the" verification check is ambiguous, and guessing wrong is worse than
 * returning null (which degrades safely to 'inconclusive', not a false
 * signal).
 */
export function extractVerificationSnippet(answerText: string): string | null {
  const tagged = answerText.match(FENCE_RE_TAGGED)
  if (tagged?.[1]) return tagged[1].trim()

  const plainMatches = [...answerText.matchAll(FENCE_RE_PLAIN_GLOBAL)]
  if (plainMatches.length === 1 && plainMatches[0]?.[1]) {
    return plainMatches[0][1].trim()
  }
  return null
}

export type VerificationOutcome = 'pass' | 'fail' | 'inconclusive'

export type VerificationResult = {
  outcome: VerificationOutcome
  /** Human-readable reason — surfaced in the bounded-retry prompt as
   * feedback and useful for debugging/eval reporting either way. */
  detail: string
  stdout: string
  stderr: string
}

/**
 * Runs and classifies a single candidate's verification snippet through the
 * Tier 1 restricted evaluator. Never throws — every failure mode (no
 * snippet, grammar-rejected, runtime error, timeout) resolves to
 * 'inconclusive' with an explanatory detail string.
 */
export async function verifyAnswer(
  answerText: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<VerificationResult> {
  const snippet = extractVerificationSnippet(answerText)
  if (!snippet) {
    return {
      outcome: 'inconclusive',
      detail: 'no verification snippet found in the response',
      stdout: '',
      stderr: '',
    }
  }

  const evalResult = await evaluateRestrictedCheck(snippet, opts)

  if (!evalResult.executed) {
    if (evalResult.timedOut) {
      return {
        outcome: 'inconclusive',
        detail: 'verification snippet timed out',
        stdout: '',
        stderr: '',
      }
    }
    return {
      outcome: 'inconclusive',
      detail: `verification snippet not executed: ${evalResult.rejectionReason}`,
      stdout: '',
      stderr: '',
    }
  }

  const { outcome } = evalResult

  if (outcome.status === 'rejected') {
    // Grammar-rejected: the restricted evaluator ran (it's always
    // executed:true once the process itself started successfully — see
    // restrictedEvaluator.ts) but correctly refused a snippet that doesn't
    // fit Tier 1's allowlist (e.g. it needs a loop, an import, or any other
    // construct outside the grammar). The candidate's check was never
    // evaluated to a value either way, so this is worded identically to the
    // "couldn't even run" case above.
    return {
      outcome: 'inconclusive',
      detail: `verification snippet not executed: ${outcome.reason}`,
      stdout: '',
      stderr: '',
    }
  }

  if (outcome.status === 'error') {
    return {
      outcome: 'inconclusive',
      detail: `verification snippet could not be evaluated: ${outcome.error}`,
      stdout: '',
      stderr: outcome.error,
    }
  }

  // outcome.status === 'result' — the check was accepted by the grammar AND
  // genuinely computed to a real boolean. This is the only path that can
  // produce 'pass' or 'fail'.
  if (outcome.value === true) {
    return {
      outcome: 'pass',
      detail: 'verification check evaluated to true',
      stdout: 'true',
      stderr: '',
    }
  }
  return {
    outcome: 'fail',
    detail: 'verification check evaluated to false',
    stdout: 'false',
    stderr: '',
  }
}
