import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Discriminated union of the three DataAnalyze operations, used only for
 * validation (see LSPTool/schemas.ts for the same pattern and the reason).
 * The tool-facing `inputSchema` in DataAnalyzeTool.ts stays a flat
 * ZodObject with every per-operation field marked optional — a
 * discriminated union at the top level of a tool's schema converts to a
 * oneOf/anyOf JSON Schema root, which this project's own MCP conversion
 * layer explicitly can't handle for outputSchema (see entrypoints/mcp.ts's
 * comment) and which a small local tool-calling model is a worse bet to
 * generate correctly than a flat schema with an `operation` enum field.
 * This union exists purely so validateInput()/call() can produce a precise
 * per-operation error message instead of a generic "missing field" one.
 */
export const dataAnalyzeToolInputSchema = lazySchema(() => {
  const questionSchema = z.strictObject({
    operation: z.literal('question'),
    table: z.object({
      columns: z.array(z.string()).min(1),
      rows: z.array(z.array(z.string())),
    }),
    question: z.string().min(1),
  })

  const predictSchema = z.strictObject({
    operation: z.literal('predict'),
    task: z.enum(['classify', 'regress']).optional(),
    train_features: z.array(z.array(z.number())).min(1),
    train_labels: z.array(z.union([z.string(), z.number()])).min(1),
    test_features: z.array(z.array(z.number())).min(1),
  })

  const forecastSchema = z.strictObject({
    operation: z.literal('forecast'),
    series: z.array(z.number()).min(1),
    horizon: z.number().int().positive(),
  })

  return z.discriminatedUnion('operation', [
    questionSchema,
    predictSchema,
    forecastSchema,
  ])
})

export type DataAnalyzeToolInput = z.infer<
  ReturnType<typeof dataAnalyzeToolInputSchema>
>
