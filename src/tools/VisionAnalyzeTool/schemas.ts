import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Discriminated union of the seven VisionAnalyze operations, used only for
 * validation (see `DataAnalyzeTool/schemas.ts` for the same pattern and the
 * reason a top-level discriminated union isn't used for the tool-facing
 * `inputSchema` itself). The tool-facing `inputSchema` in
 * `VisionAnalyzeTool.ts` stays a flat `ZodObject` with every per-operation
 * field marked optional; `validateInput()`/`call()` re-validate against
 * this union to enforce which fields are actually required for the chosen
 * operation and to produce a precise error message.
 *
 * `image_path` is required by every operation (unlike `DataAnalyzeTool`,
 * where the shared field varies by operation) — mirrors
 * `AudioAnalyzeTool/schemas.ts`'s note that `audio_path` being universally
 * required means this union's main job is rejecting operation-mismatched
 * fields (e.g. `labels` supplied with `operation: "segment"`) rather than
 * catching a missing shared field.
 *
 * `"embed"` (CLIP) and `"embed-dinov2"` (DINOv2) are two separate operations
 * rather than one `"embed"` operation with a `model: "clip" | "dinov2"`
 * sub-parameter — a deliberate call, not the default shape `DataAnalyzeTool`
 * uses for its analogous `task` sub-parameter on `"predict"`. Reasoning: the
 * two embedding spaces are not just "two settings of the same computation"
 * the way classify/regress are — they're different models producing
 * differently-dimensioned, non-comparable vectors (768-dim CLIP vs. 384-dim
 * DINOv2; a cosine similarity between one of each is meaningless), so
 * collapsing them behind one sub-parameter would invite a caller to treat
 * them as interchangeable. Keeping them as separate top-level operations
 * lets each one carry its own distinct description in the `operation` enum
 * itself (see `VisionAnalyzeTool.ts`'s inputSchema and `prompt.ts`), which is
 * the more legible shape for a small local tool-calling model to pick
 * correctly between "general-purpose, text-alignable embedding" (CLIP) and
 * "pure visual-similarity embedding, no text alignment" (DINOv2) — the
 * actual decision a caller needs to make, not a generic "which embedder".
 */
export const visionAnalyzeToolInputSchema = lazySchema(() => {
  const captionSchema = z.strictObject({
    operation: z.literal('caption'),
    image_path: z.string().min(1),
  })

  const classifySchema = z.strictObject({
    operation: z.literal('classify'),
    image_path: z.string().min(1),
    labels: z.array(z.string().min(1)).min(1),
  })

  const embedSchema = z.strictObject({
    operation: z.literal('embed'),
    image_path: z.string().min(1),
  })

  const embedDinov2Schema = z.strictObject({
    operation: z.literal('embed-dinov2'),
    image_path: z.string().min(1),
  })

  const segmentSchema = z.strictObject({
    operation: z.literal('segment'),
    image_path: z.string().min(1),
    prompt: z.string().min(1),
    threshold: z.number().gt(0).lt(1).optional(),
  })

  const detectSchema = z.strictObject({
    operation: z.literal('detect'),
    image_path: z.string().min(1),
    queries: z.array(z.string().min(1)).min(1),
    threshold: z.number().gt(0).lt(1).optional(),
  })

  const poseSchema = z.strictObject({
    operation: z.literal('pose'),
    image_path: z.string().min(1),
    boxes: z.array(z.array(z.number()).length(4)).optional(),
  })

  return z.discriminatedUnion('operation', [
    captionSchema,
    classifySchema,
    embedSchema,
    embedDinov2Schema,
    segmentSchema,
    detectSchema,
    poseSchema,
  ])
})

export type VisionAnalyzeToolInput = z.infer<
  ReturnType<typeof visionAnalyzeToolInputSchema>
>
