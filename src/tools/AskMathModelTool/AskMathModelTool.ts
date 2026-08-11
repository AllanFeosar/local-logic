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
import { DESCRIPTION, PROMPT } from './prompt.js'
import { stripThinkTrace } from './thinkTrace.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    problem: z
      .string()
      .describe(
        'The math problem to solve, including all relevant context (prior work, constraints, what form the answer should take). The specialist model sees only this string, not the rest of the conversation.',
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
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.problem
  },
  async checkPermissions(input) {
    // Pure local computation (localhost-only Ollama call), no filesystem or
    // network side effects worth gating behind a permission prompt.
    return { behavior: 'allow', updatedInput: input }
  },
  getActivityDescription() {
    return 'Consulting math specialist model (this can take several minutes)'
  },
  renderToolUseMessage() {
    return null
  },
  async call({ problem }, context) {
    const start = Date.now()
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
  mapToolResultToToolResultBlockParam({ answer, truncated }, toolUseID) {
    const content = truncated
      ? `[NOTE: this response may be incomplete — the specialist model's answer was cut off or unclear]\n\n${answer}`
      : answer
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
