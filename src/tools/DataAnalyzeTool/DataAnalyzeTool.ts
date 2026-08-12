import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  MODEL_BRIDGE_BASE_URL,
  MODEL_BRIDGE_TIMEOUT_MS,
  modelBridgeUnavailableMessage,
} from '../shared/localModelBridge.js'
import { inferPredictTask } from './predictTask.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { dataAnalyzeToolInputSchema } from './schemas.js'

const TOOL_NAME = 'DataAnalyze'

/**
 * Tool-facing input schema: a flat ZodObject with every per-operation field
 * marked optional (rather than the discriminated union in schemas.ts — see
 * that file's comment for why). validateInput()/call() re-validate against
 * the discriminated union to enforce which fields are actually required
 * for the chosen operation and to produce a precise error message.
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['question', 'predict', 'forecast'])
      .describe(
        'Which tabular/data-analysis task to perform: "question" answers a natural-language question about a table, "predict" trains a tabular ML model on labeled examples and predicts on new rows, "forecast" extrapolates a numeric time series. Pick exactly one.',
      ),

    // operation: "question"
    table: z
      .object({
        columns: z.array(z.string()).describe('Column headers, in order'),
        rows: z
          .array(z.array(z.string()))
          .describe(
            'Table rows; each row is an array of string cell values in the same order as columns',
          ),
      })
      .optional()
      .describe(
        'Required when operation is "question": the table to answer the question about.',
      ),
    question: z
      .string()
      .optional()
      .describe(
        'Required when operation is "question": the natural-language question to answer using the table.',
      ),

    // operation: "predict"
    task: z
      .enum(['classify', 'regress'])
      .optional()
      .describe(
        'Optional for operation "predict": whether to predict a category ("classify", e.g. spam/not-spam, species, risk tier) or a continuous number ("regress", e.g. price, temperature). If omitted, it is inferred from train_labels (string labels, or few repeated small-integer labels, read as "classify"; many distinct or fractional numeric labels read as "regress") — specify explicitly if that inference could be wrong for your data.',
      ),
    train_features: z
      .array(z.array(z.number()))
      .optional()
      .describe(
        'Required when operation is "predict": training rows of numeric features, one array per row, same column order for every row.',
      ),
    train_labels: z
      .array(z.union([z.string(), z.number()]))
      .optional()
      .describe(
        'Required when operation is "predict": one label per training row, same order and length as train_features.',
      ),
    test_features: z
      .array(z.array(z.number()))
      .optional()
      .describe(
        'Required when operation is "predict": rows to predict labels for, same feature columns/order as train_features.',
      ),

    // operation: "forecast"
    series: z
      .array(z.number())
      .optional()
      .describe(
        'Required when operation is "forecast": the historical numeric series, oldest value first.',
      ),
    horizon: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Required when operation is "forecast": how many future steps to forecast beyond the end of series.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    operation: z
      .enum(['question', 'predict', 'forecast'])
      .describe('Which operation this result is for'),

    // "question"
    answer: z
      .string()
      .optional()
      .describe('Present for operation "question": the answer extracted from the table'),
    cells: z
      .array(z.object({ row: z.number().int().nonnegative(), column: z.number().int().nonnegative() }))
      .optional()
      .describe(
        'Present for operation "question": 0-indexed table cells the answer was grounded in (empty if the model could not ground it to specific cells)',
      ),

    // "predict"
    task: z
      .enum(['classify', 'regress'])
      .optional()
      .describe('Present for operation "predict": which mode actually ran (explicit or inferred)'),
    predictions: z
      .array(z.union([z.string(), z.number()]))
      .optional()
      .describe('Present for operation "predict": one prediction per row of test_features, same order'),
    probabilities: z
      .array(z.array(z.number()))
      .optional()
      .describe(
        'Present for operation "predict" when task is "classify": per-class probabilities for each test row',
      ),

    // "forecast"
    forecast: z
      .array(z.number())
      .optional()
      .describe('Present for operation "forecast": median forecast values, length = horizon'),
    low: z
      .array(z.number())
      .optional()
      .describe('Present for operation "forecast" if the model exposes uncertainty bounds: lower band'),
    high: z
      .array(z.number())
      .optional()
      .describe('Present for operation "forecast" if the model exposes uncertainty bounds: upper band'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type TableQAResponse = {
  answer: string
  cells: Array<{ row: number; column: number }>
}
type TabularPredictResponse = {
  predictions: Array<string | number>
  probabilities?: number[][]
}
type ForecastResponse = {
  forecast: number[]
  low?: number[]
  high?: number[]
}

async function postBridge<T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${MODEL_BRIDGE_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (cause) {
    throw new Error(modelBridgeUnavailableMessage(cause))
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(
      `DataAnalyze request to ${path} failed: ${response.status} ${response.statusText} ${errorBody}`,
    )
  }

  return (await response.json()) as T
}

function activityLabel(operation: Input['operation'] | undefined): string {
  switch (operation) {
    case 'question':
      return 'Answering a question about the table'
    case 'predict':
      return 'Running the tabular prediction model'
    case 'forecast':
      return 'Forecasting the series'
    default:
      return 'Analyzing tabular data'
  }
}

export const DataAnalyzeTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'table question answering, tabular prediction, and time-series forecasting',
  maxResultSizeChars: 20_000,
  // See AskMathModelTool.ts for why this is deliberately not deferred.
  shouldDefer: false,
  async description(input) {
    return activityLabel(input.operation)
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
    switch (input.operation) {
      case 'question':
        return input.question ?? ''
      case 'predict':
        return `predict ${input.task ?? ''}`.trim()
      case 'forecast':
        return `forecast horizon ${input.horizon ?? ''}`.trim()
      default:
        return ''
    }
  },
  async validateInput(input) {
    const parsed = dataAnalyzeToolInputSchema().safeParse(input)
    if (!parsed.success) {
      return {
        result: false,
        message: `Invalid input for operation "${input.operation}": ${parsed.error.message}`,
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input) {
    // Pure local computation against the local model bridge (loopback
    // only), no filesystem or network side effects worth gating behind a
    // permission prompt — matching AskMathModelTool/DocumentQATool/
    // ImageCaptionTool's posture.
    return { behavior: 'allow', updatedInput: input }
  },
  getActivityDescription(input) {
    return activityLabel(input?.operation)
  },
  renderToolUseMessage() {
    return null
  },
  async call(rawInput, context) {
    const parsed = dataAnalyzeToolInputSchema().safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid DataAnalyze input: ${parsed.error.message}`)
    }
    const input = parsed.data

    const { signal, cleanup } = createCombinedAbortSignal(context.abortController.signal, {
      timeoutMs: MODEL_BRIDGE_TIMEOUT_MS,
    })

    try {
      switch (input.operation) {
        case 'question': {
          const data = await postBridge<TableQAResponse>(
            '/table-qa',
            { question: input.question, table: input.table },
            signal,
          )
          return {
            data: {
              operation: 'question',
              answer: data.answer,
              cells: data.cells,
            } satisfies Output,
          }
        }
        case 'predict': {
          const task = input.task ?? inferPredictTask(input.train_labels)
          const data = await postBridge<TabularPredictResponse>(
            '/tabular-predict',
            {
              operation: task,
              train_features: input.train_features,
              train_labels: input.train_labels,
              test_features: input.test_features,
            },
            signal,
          )
          return {
            data: {
              operation: 'predict',
              task,
              predictions: data.predictions,
              probabilities: data.probabilities,
            } satisfies Output,
          }
        }
        case 'forecast': {
          const data = await postBridge<ForecastResponse>(
            '/forecast',
            { series: input.series, horizon: input.horizon },
            signal,
          )
          return {
            data: {
              operation: 'forecast',
              forecast: data.forecast,
              low: data.low,
              high: data.high,
            } satisfies Output,
          }
        }
      }
    } finally {
      cleanup()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    let content: string
    switch (output.operation) {
      case 'question': {
        const cellCount = output.cells?.length ?? 0
        const groundingNote =
          cellCount > 0
            ? ` (grounded in ${cellCount} cell${cellCount === 1 ? '' : 's'})`
            : ' [NOTE: the model did not ground this answer to specific cells — treat with caution]'
        content = `${output.answer ?? ''}${groundingNote}`
        break
      }
      case 'predict': {
        content = `Task: ${output.task}\nPredictions: ${JSON.stringify(output.predictions ?? [])}`
        if (output.probabilities) {
          content += `\nProbabilities: ${JSON.stringify(output.probabilities)}`
        }
        break
      }
      case 'forecast': {
        content = `Forecast: ${JSON.stringify(output.forecast ?? [])}`
        if (output.low && output.high) {
          content += `\nRange: ${JSON.stringify(output.low)} to ${JSON.stringify(output.high)}`
        }
        break
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// Re-exported for the "no wrapping DESCRIPTION" case some tests want to
// assert against directly (matches AskMathModelTool.ts's convention).
export { DESCRIPTION }
