import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Discriminated union of the two AudioAnalyze operations, used only for
 * validation (see `DataAnalyzeTool/schemas.ts` for the same pattern and the
 * reason a top-level discriminated union isn't used for the tool-facing
 * `inputSchema` itself — the JSON-Schema `oneOf`/`anyOf` root it produces
 * isn't supported by this project's MCP conversion layer, and a flat schema
 * with an enum field is also the better bet for a small local tool-calling
 * model to generate correctly).
 *
 * Unlike `DataAnalyzeTool`, `audio_path` is required by both operations
 * here, so this union's main job isn't catching a missing shared field —
 * it's rejecting the operation-specific fields when they're supplied for
 * the *wrong* operation (e.g. `threshold` with `operation: "transcribe"`,
 * which the bridge's `/transcribe` route doesn't even accept and would
 * otherwise be silently dropped rather than flagged as caller confusion).
 */
export const audioAnalyzeToolInputSchema = lazySchema(() => {
  const transcribeSchema = z.strictObject({
    operation: z.literal('transcribe'),
    audio_path: z.string().min(1),
    language: z.string().min(1).optional(),
  })

  const vadSchema = z.strictObject({
    operation: z.literal('vad'),
    audio_path: z.string().min(1),
    threshold: z.number().gt(0).lt(1).optional(),
    min_speech_duration_ms: z.number().positive().optional(),
    min_silence_duration_ms: z.number().positive().optional(),
    speech_pad_ms: z.number().nonnegative().optional(),
  })

  return z.discriminatedUnion('operation', [transcribeSchema, vadSchema])
})

export type AudioAnalyzeToolInput = z.infer<
  ReturnType<typeof audioAnalyzeToolInputSchema>
>
