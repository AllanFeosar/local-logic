import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  ASK_MATH_MODEL_TOOL_NAME,
  MATH_MODEL_BASE_URL,
  MATH_MODEL_MAX_TOKENS,
  MATH_MODEL_NAME,
  MATH_MODEL_TIMEOUT_MS,
} from './constants.js'
import { solveDeep } from './deepSolve/solveDeep.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { stripThinkTrace } from './thinkTrace.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    problem: z
      .string()
      .describe(
        'The math problem to solve, including all relevant context (prior work, constraints, what form the answer should take). The specialist model sees only this string, not the rest of the conversation.',
      ),
    deep: z
      .boolean()
      .optional()
      .describe(
        'Opt-in deep mode (default false — leave unset for almost every call). Instead of one pass, generates several candidate solutions and actually EXECUTES a locally-generated Python check against each one (not just asks about it), only falling back to a learned re-ranker when code alone cannot decide. Takes roughly N x 1-5 minutes and can run past 30 minutes on a hard problem with a failed first round. Only set this when the problem is genuinely hard (competition-style, multi-step, easy to get subtly wrong), getting it right actually matters more than getting it fast, and you are willing to wait — never for a problem a single pass would plausibly nail.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    answer: z.string().describe("The specialist model's final answer, with its reasoning trace stripped"),
    truncated: z
      .boolean()
      .describe('True if the response may be incomplete (generation was cut off before a clean answer emerged)'),
    durationMs: z.number().describe('Time taken for the specialist model to respond'),
    verified: z
      .boolean()
      .optional()
      .describe(
        'Deep mode only. True only if this exact answer was proven correct by actually executing a generated check against it locally — not merely self-reported by the model.',
      ),
    verificationMethod: z
      .enum(['code-verified', 'reranker-scored', 'self-consistency', 'best-effort-unverified'])
      .optional()
      .describe('Deep mode only. How the returned answer was selected among the candidates generated.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

type OllamaChatCompletion = {
  choices?: Array<{ message?: { content?: string } }>
}

export const AskMathModelTool = buildTool({
  name: ASK_MATH_MODEL_TOOL_NAME,
  searchHint: 'delegate a math problem to a specialist reasoning model',
  maxResultSizeChars: 50_000,
  // Deliberately NOT deferred: defer_loading/ToolSearch is Anthropic-
  // Messages-API beta plumbing (see claude.ts) of uncertain behavior once
  // translated through openaiShim.ts to Ollama's OpenAI-compatible format,
  // and a small local router model is a poor bet to spontaneously call
  // ToolSearch for a tool it doesn't know exists. Always-visible costs a
  // small amount of context; a tool the router can't discover is useless.
  shouldDefer: false,
  async description() {
    return 'Consulting the local math specialist model'
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input) {
    // Single-shot mode is a pure local computation (localhost-only Ollama
    // call) with zero side effects — read-only. Deep mode is NOT: it spawns
    // a local Python process per candidate/retry to run the Tier 1
    // restricted verification evaluator (see
    // deepSolve/restrictedEvaluator.ts — no temp file is written, unlike
    // the retired pythonSandbox.ts, but a real OS process is still
    // launched). This must reflect that accurately rather than
    // unconditionally returning true — checked every
    // call site of Tool.isReadOnly() in this codebase before making it
    // input-dependent (2026-08-12 security review, Finding 4): two
    // real-code call sites are BashTool-name-scoped
    // (extractMemories.ts's createAutoMemCanUseTool, only reads
    // tool.isReadOnly when tool.name === BASH_TOOL_NAME) and MCP-tool
    // capability advertising (cli/print.ts, only for MCP-server tools, and
    // always called with input `{}` — `{}.deep` is undefined, so it
    // resolves to the same `true` this returned before, unchanged for that
    // call site regardless). A third call site
    // (FilesystemPermissionRequest.tsx) only uses the value to pick
    // "Read"/"Edit" UI label text inside a filesystem permission dialog
    // AskMathModelTool never routes through, and the direction of this
    // change (true → false) is the strictly more cautious one regardless
    // (independent security-audit-agent, 2026-08-12, round 4 — flagged as a
    // doc-accuracy note, not a security finding). None of the three is
    // affected by this becoming input-dependent for AskMathModelTool
    // specifically.
    return !input?.deep
  },
  toAutoClassifierInput(input) {
    return input.problem
  },
  async checkPermissions(input) {
    // Single-shot mode: pure local computation (localhost-only Ollama
    // call), no filesystem or network side effects worth gating behind a
    // permission prompt. Unconditional allow, unchanged from before.
    //
    // SECURITY FIX (2026-08-12 review, Finding 4): deep mode used to also
    // return unconditional 'allow' here even though it spawns local Python
    // processes to execute LLM-generated verification snippets — meaning no
    // permission prompt ever fired for that code-execution capability, in
    // ANY permission mode (default, plan, headless), before it ran. That was
    // flagged in the prior session as a genuine open judgment call, and the
    // review confirmed it needed to change. (2026-08-12, Session 11: the
    // execution mechanism itself was later replaced — see
    // deepSolve/restrictedEvaluator.ts and
    // LOCAL_AI_MASTER_PLAN.md §11 "Verifier isolation" — but this gate is
    // kept unchanged since deep mode still spawns a local process per
    // candidate/retry either way.)
    //
    // Fixed by gating at the call() level (once per tool invocation, not
    // per-candidate — preserves the original, still-legitimate UX goal of
    // not prompting up to N+1 times per call): when input.deep is true,
    // return 'ask' instead of 'allow'. This reuses the same idiom this
    // codebase already uses elsewhere for a tool that's usually
    // side-effect-free but occasionally consequential (see
    // ConfigTool.ts's checkPermissions: unconditional 'allow' for a plain
    // read, plain 'ask' — not tied to a path/content rule — for the
    // consequential branch) rather than building bespoke rule-matching like
    // BashTool/FileEditTool do for path-keyed permissions, which doesn't
    // apply here (deep mode has no natural "path" or rule-content to key
    // on). Returning a plain (non-rule-keyed) 'ask' still composes correctly
    // with the general permission pipeline
    // (src/utils/permissions/permissions.ts): bypassPermissions mode still
    // bypasses it (the documented, existing escape hatch — not a new one),
    // and a user's "always allow AskMathModel" tool-level rule still
    // short-circuits it after the first approval, so it does not nag on
    // every subsequent deep-mode call once granted. In a session with
    // shouldAvoidPermissionPrompts (headless, can't show UI), 'ask' is
    // auto-denied — fails closed, matching every other tool's behavior
    // there, not a hang and not a silent allow.
    if (input.deep) {
      return {
        behavior: 'ask',
        message:
          'Deep mode generates several candidate solutions and checks each one with a restricted local arithmetic evaluator (no shell, no imports, no attribute access — only numeric expressions, comparisons, and a small fixed math-function table; see deepSolve/restrictedEvaluator.ts). Approve to let this run?',
      }
    }
    return { behavior: 'allow', updatedInput: input }
  },
  getActivityDescription(input) {
    return input?.deep
      ? 'Consulting math specialist model in deep mode (generate, verify, and search — this can take tens of minutes)'
      : 'Consulting math specialist model (this can take several minutes)'
  },
  renderToolUseMessage() {
    return null
  },
  async call({ problem, deep }, context) {
    const start = Date.now()

    if (deep) {
      // Deep mode manages its own per-request timeouts internally (one
      // MATH_MODEL_TIMEOUT_MS-bounded combined signal per candidate/retry
      // call, see deepSolve/generateCandidates.ts) — no additional outer
      // deadline is layered on top here, since the legitimate worst case
      // (N candidates + one retry, each up to MATH_MODEL_TIMEOUT_MS) is
      // already the honestly-documented cost of this mode, not a bug to
      // truncate early.
      const result = await solveDeep(problem, context.abortController.signal)
      return {
        data: {
          answer: result.answer,
          truncated: result.truncated,
          durationMs: Date.now() - start,
          verified: result.verified,
          verificationMethod: result.method,
        } satisfies Output,
      }
    }

    const { signal, cleanup } = createCombinedAbortSignal(context.abortController.signal, {
      timeoutMs: MATH_MODEL_TIMEOUT_MS,
    })

    try {
      const response = await fetch(`${MATH_MODEL_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MATH_MODEL_NAME,
          messages: [{ role: 'user', content: problem }],
          stream: false,
          max_tokens: MATH_MODEL_MAX_TOKENS,
        }),
        signal,
      })

      if (!response.ok) {
        throw new Error(
          `Math model request failed: ${response.status} ${response.statusText}`,
        )
      }

      const data = (await response.json()) as OllamaChatCompletion
      const raw = data.choices?.[0]?.message?.content ?? ''
      const { answer, truncated } = stripThinkTrace(raw)

      return {
        data: {
          answer,
          truncated,
          durationMs: Date.now() - start,
        } satisfies Output,
      }
    } finally {
      cleanup()
    }
  },
  mapToolResultToToolResultBlockParam({ answer, truncated, verified, verificationMethod }, toolUseID) {
    const notes: string[] = []
    if (truncated) {
      notes.push("this response may be incomplete — the specialist model's answer was cut off or unclear")
    }
    if (verificationMethod) {
      notes.push(
        verified
          ? 'deep mode: this answer was verified by actually executing a generated correctness check against it locally'
          : `deep mode: no candidate could be proven correct by code execution — this is the pipeline's best-effort pick (${verificationMethod}), treat it as lower-confidence than a code-verified answer`,
      )
    }
    const content = notes.length > 0 ? `[NOTE: ${notes.join('; ')}]\n\n${answer}` : answer
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// Re-exported for the "no wrapping DESCRIPTION" case some tests want to
// assert against directly.
export { DESCRIPTION }
