import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import {
  MATH_MODEL_BASE_URL,
  MATH_MODEL_MAX_TOKENS,
  MATH_MODEL_NAME,
  MATH_MODEL_TIMEOUT_MS,
} from '../constants.js'
import { stripThinkTrace } from '../thinkTrace.js'
import { extractVerificationSnippet } from './verification.js'

/**
 * §11 pipeline step 1: best-of-N generation, temperature-varied.
 *
 * Confirmed live (not assumed) that per-request `temperature` is honored by
 * Ollama's OpenAI-compatible /v1/chat/completions endpoint for this model:
 * `ollama show` on the VibeThinker tag reports no PARAMETER block at all (no
 * pinned temperature in its Modelfile), and two live calls with the same
 * prompt at temperature 0.0 vs 1.9 produced visibly different reasoning
 * length/style and different final answers — this is NOT true of every
 * field this project has tried against this Ollama install (num_ctx and the
 * native `think` field were both previously found to be silently ignored by
 * this same endpoint; temperature is not one of those). No parallel model
 * tag or workaround was needed.
 *
 * Kept modest (not up to 1.9) because that same live test also showed high
 * temperature meaningfully increases the odds of a rambling, never-closed
 * <think> trace that blows the token budget before reaching a final answer
 * (i.e. `truncated: true`) — counterproductive for a pipeline whose whole
 * point is reliability, not diversity for its own sake.
 */
export const DEEP_MODE_TEMPERATURES = [0.2, 0.5, 0.8, 1.0, 1.2] as const

export const DEEP_MODE_DEFAULT_N = 3
export const DEEP_MODE_MAX_N = DEEP_MODE_TEMPERATURES.length

export type Candidate = {
  index: number
  temperature: number
  /** Raw completion including the <think> trace, kept for debugging/eval. */
  rawContent: string
  /** Final answer text with the <think> trace stripped (may itself contain
   * the fenced verification snippet — same convention as AskMathModelTool's
   * existing single-shot `answer` field). */
  answer: string
  truncated: boolean
  verificationSnippetPresent: boolean
  durationMs: number
}

/**
 * 2026-08-12 (Session 11): rewritten for the Tier 1 restricted AST
 * evaluator (restrictedEvaluator.ts) — see LOCAL_AI_MASTER_PLAN.md §11
 * "Verifier isolation — the settled answer". Candidates used to be asked
 * for arbitrary Python with a fixed stdlib-import allowlist, executed
 * behind a denylist (pythonSandbox.ts, now retired — three independent
 * security rounds found the denylist shape itself was unwinnable). The
 * restricted evaluator does not run Python at all — it walks a small,
 * fixed set of AST node types itself — so this prompt now asks for exactly
 * that narrower grammar instead of "write a Python script": plain
 * arithmetic, comparisons, and calls to a small fixed function table, no
 * imports, no loops, no `print`. The instructions below are the candidate-
 * facing description of that same grammar restrictedEvaluator.ts enforces
 * server-side — keep the two in sync if either changes.
 */
function buildVerifyInstructions(): string {
  return `After you finish reasoning, give your final answer, then a verification check in a fenced code block tagged \`python-verify\` that independently confirms your final answer is correct — e.g. by recomputing it from the problem's given values via a different method than you used above, or by substituting it back into the problem's stated equation/constraints and confirming it holds. The check is evaluated by a restricted arithmetic evaluator, NOT a full Python interpreter — it understands only:
- Numbers, and the operators + - * / // % ** (exponent) and comparisons == != < <= > >=, combined with "and"/"or" if needed.
- Calls to ONLY these functions: sqrt, abs, pow (2-arg exponent or 3-arg modular form), gcd, lcm, factorial, min, max, round, floor, ceil, sum, isclose.
- Optionally, a few lines above the check that assign a plain variable name to a value, e.g. \`computed = 17 * 23\`, so the final line can compare against it.
It does NOT support imports, loops, function/class definitions, lists, strings, attribute access (like \`math.sqrt\`, just \`sqrt\`), or any statement other than a simple assignment. Do NOT print anything — there is no \`print\`.

Requirements:
- The LAST line of the code block must itself be the check — a comparison (e.g. \`computed == expected\`), a combination of comparisons with and/or, or a call to \`isclose(a, b)\` for a tolerance-based check. This is the value that is evaluated; do not assign it to a variable and stop there.
- Perform a real, independent recomputation — do not write a tautology like \`4 == 4\`.
- If the problem cannot be checked this way (it needs a loop, a simulation, or anything else outside this restricted grammar), it is fine to omit the code block entirely rather than force an invalid one.

Format your response exactly like this:

Final answer: <your answer>

\`\`\`python-verify
<optional assignment lines>
<the final comparison, which is the check itself>
\`\`\``
}

export function buildDeepPrompt(problem: string): string {
  return `${problem}\n\n${buildVerifyInstructions()}`
}

export function buildRetryPrompt(
  problem: string,
  failedAttempts: Array<{ answer: string; verifierDetail: string }>,
): string {
  const attempts = failedAttempts
    .map(
      (a, i) =>
        `Attempt ${i + 1}:\n${a.answer}\nVerifier found this incorrect: ${a.verifierDetail}`,
    )
    .join('\n\n')

  return `${problem}

Previous attempts at this exact problem were checked with real code execution and found incorrect:

${attempts}

Solve the problem again from scratch, being careful not to repeat the same mistake(s) described above.

${buildVerifyInstructions()}`
}

type OllamaChatCompletion = {
  choices?: Array<{ message?: { content?: string } }>
}

async function requestCompletion(
  prompt: string,
  temperature: number,
  signal: AbortSignal,
): Promise<{ raw: string }> {
  const response = await fetch(`${MATH_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MATH_MODEL_NAME,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: MATH_MODEL_MAX_TOKENS,
      temperature,
    }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Math model request failed: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as OllamaChatCompletion
  return { raw: data.choices?.[0]?.message?.content ?? '' }
}

/**
 * Generates one candidate at the given temperature. Reuses the exact same
 * request shape as AskMathModelTool's single-shot call() (same endpoint,
 * same model, same think-trace stripping) plus the verification
 * instructions and a per-request temperature override.
 */
export async function generateCandidate(
  problem: string,
  temperature: number,
  index: number,
  parentSignal: AbortSignal,
): Promise<Candidate> {
  const start = Date.now()
  const { signal, cleanup } = createCombinedAbortSignal(parentSignal, {
    timeoutMs: MATH_MODEL_TIMEOUT_MS,
  })
  try {
    const { raw } = await requestCompletion(buildDeepPrompt(problem), temperature, signal)
    const { answer, truncated } = stripThinkTrace(raw)
    return {
      index,
      temperature,
      rawContent: raw,
      answer,
      truncated,
      verificationSnippetPresent: extractVerificationSnippet(answer) !== null,
      durationMs: Date.now() - start,
    }
  } finally {
    cleanup()
  }
}

/**
 * Generates the single bounded-retry candidate (§11 pipeline step 4):
 * re-prompts with the failed attempts + verifier feedback baked into the
 * prompt itself, not a second round of best-of-N.
 */
export async function generateRetryCandidate(
  problem: string,
  failedAttempts: Array<{ answer: string; verifierDetail: string }>,
  index: number,
  parentSignal: AbortSignal,
): Promise<Candidate> {
  const start = Date.now()
  const { signal, cleanup } = createCombinedAbortSignal(parentSignal, {
    timeoutMs: MATH_MODEL_TIMEOUT_MS,
  })
  try {
    // Moderate, non-extreme temperature — enough to actually try something
    // different from the failed attempts without the rambling/truncation
    // risk seen at the high end of DEEP_MODE_TEMPERATURES.
    const retryTemperature = 0.6
    const { raw } = await requestCompletion(
      buildRetryPrompt(problem, failedAttempts),
      retryTemperature,
      signal,
    )
    const { answer, truncated } = stripThinkTrace(raw)
    return {
      index,
      temperature: retryTemperature,
      rawContent: raw,
      answer,
      truncated,
      verificationSnippetPresent: extractVerificationSnippet(answer) !== null,
      durationMs: Date.now() - start,
    }
  } finally {
    cleanup()
  }
}
