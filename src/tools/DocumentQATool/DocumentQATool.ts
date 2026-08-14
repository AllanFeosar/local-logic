import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  MODEL_BRIDGE_BASE_URL,
  MODEL_BRIDGE_TIMEOUT_MS,
  modelBridgeUnavailableMessage,
} from '../shared/localModelBridge.js'

const TOOL_NAME = 'DocumentQA'

const DESCRIPTION = `Answers a question by extracting the relevant span directly from a supplied text passage, via a local extractive-QA model (distilbert-base-cased-distilled-squad). This is not a general assistant — it can only point at where in the given text the answer already appears, it cannot reason, summarize, or answer from outside the passage. Use it when you have a specific passage (e.g. from a file you've read) and want a fast, precise answer to a factual question the text actually contains. If the answer isn't literally present in the passage, expect a low score and a poor-quality extracted span rather than a helpful response.

Use this whenever the source is prose (sentences/paragraphs), even when the question asks for a specific number or fact — e.g. "Here is a passage: '...is over 13,000 miles long...' Question: How long is X? Answer using only the passage." is THIS tool, not DataAnalyze, because there is no table here, only sentences. If the source is instead a table (columns + rows), use DataAnalyze's "question" operation instead — the presence of columns/rows, not whether the answer happens to be a number, is what decides which of the two to use.

Requires an actual passage already supplied or already read (e.g. from a file) — do not call this without one. General-knowledge trivia with no passage attached (e.g. "give me a fun fact about octopuses") is not a document-QA task, even though it's phrased as a question with a factual answer — this tool cannot invent, recall, or fetch source text, only extract from text you already have.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    question: z.string().describe('The question to answer'),
    context: z.string().describe('The passage to extract the answer from — must contain the answer verbatim'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    answer: z.string().describe('The extracted answer span'),
    score: z.number().describe('Model confidence, 0-1 — low scores mean the passage likely does not contain a good answer'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const DocumentQATool = buildTool({
  name: TOOL_NAME,
  searchHint: 'extract an answer to a question from a passage of text',
  maxResultSizeChars: 20_000,
  // See AskMathModelTool.ts for why this is deliberately not deferred.
  shouldDefer: false,
  async description() {
    return 'Extracting an answer from the supplied passage'
  },
  async prompt() {
    return DESCRIPTION
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
    return input.question
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  getActivityDescription() {
    return 'Running local document-QA model'
  },
  renderToolUseMessage() {
    return null
  },
  async call({ question, context: passage }, context) {
    const { signal, cleanup } = createCombinedAbortSignal(context.abortController.signal, {
      timeoutMs: MODEL_BRIDGE_TIMEOUT_MS,
    })

    try {
      let response: Response
      try {
        response = await fetch(`${MODEL_BRIDGE_BASE_URL}/document-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, context: passage }),
          signal,
        })
      } catch (cause) {
        throw new Error(modelBridgeUnavailableMessage(cause))
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Document QA request failed: ${response.status} ${response.statusText} ${body}`)
      }

      const data = (await response.json()) as Output
      return { data }
    } finally {
      cleanup()
    }
  },
  mapToolResultToToolResultBlockParam({ answer, score }, toolUseID) {
    const content =
      score < 0.1
        ? `${answer}\n\n[NOTE: low confidence (${score.toFixed(2)}) — this passage may not actually contain a good answer to the question]`
        : `${answer} (confidence: ${score.toFixed(2)})`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
