import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { MODEL_BRIDGE_TIMEOUT_MS } from '../shared/localModelBridge.js'
import {
  callClipClassify,
  callClipEmbed,
  callClipSegSegment,
  callDinov2Embed,
  callImageCaption,
  callOwlv2Detect,
  callVitPosePose,
} from '../shared/visionBridge.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { visionAnalyzeToolInputSchema } from './schemas.js'

const TOOL_NAME = 'VisionAnalyze'

/**
 * Tool-facing input schema: a flat ZodObject with every per-operation field
 * marked optional (rather than the discriminated union in schemas.ts — see
 * that file's comment, mirroring `DataAnalyzeTool`/`AudioAnalyzeTool`).
 * validateInput()/call() re-validate against the discriminated union to
 * enforce which fields are actually valid for the chosen operation and to
 * produce a precise error message.
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['caption', 'classify', 'embed', 'embed-dinov2', 'segment', 'detect', 'pose'])
      .describe(
        'Which vision task to perform: "caption" describes the image generically (no predefined labels); "classify" scores the image against candidate labels you supply; "detect" finds WHERE objects matching text queries appear (boxes, possibly several per query); "segment" locates ONE described region and returns a derived bounding box; "pose" estimates human body keypoints; "embed" produces a general-purpose CLIP image embedding (also text-alignable); "embed-dinov2" produces a purely-visual DINOv2 embedding (NOT comparable to CLIP\'s embedding space — different model, different dimensionality). Pick exactly one.',
      ),
    image_path: z
      .string()
      .describe('Absolute local filesystem path to the image file. Required for every operation.'),

    // operation: "classify"
    labels: z
      .array(z.string())
      .optional()
      .describe(
        'Required for operation "classify": candidate labels to score the image against (e.g. ["a cat", "a dog"]). Results are ranked and sum to 1 across these labels only — not a calibrated open-set probability, and not evidence about any label you did not include.',
      ),

    // operation: "detect"
    queries: z
      .array(z.string())
      .optional()
      .describe(
        'Required for operation "detect": open-vocabulary text queries describing objects to locate (e.g. ["a red car", "a dog"]). Each query can produce zero, one, or multiple detections.',
      ),

    // operation: "segment"
    prompt: z
      .string()
      .optional()
      .describe(
        'Required for operation "segment": a single text description of the one thing to locate (e.g. "the red circle"). Returns a derived bounding box, not a pixel mask.',
      ),

    // operation: "segment" and "detect"
    threshold: z
      .number()
      .optional()
      .describe(
        'Optional tuning knob, used by "segment" (default 0.5 — the default has a known false-positive tendency on genuinely absent objects; raise to ~0.7 for a stricter "is this actually present" read) and "detect" (default 0.1 — raise to cut low-confidence noise, lower to catch more borderline matches). Ignored by every other operation.',
      ),

    // operation: "pose"
    boxes: z
      .array(z.array(z.number()))
      .optional()
      .describe(
        'Optional, only used by operation "pose": known person bounding boxes in COCO [x, y, width, height] format, one array of exactly 4 numbers per person (e.g. from a prior "detect" call with a "person" query). Omit to run on the whole image as a single person.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const boxSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
})

const outputSchema = lazySchema(() =>
  z.object({
    operation: z
      .enum(['caption', 'classify', 'embed', 'embed-dinov2', 'segment', 'detect', 'pose'])
      .describe('Which operation this result is for'),

    // "caption"
    caption: z.string().optional().describe('Present for operation "caption": the generated caption'),

    // "classify"
    predictions: z
      .array(z.object({ label: z.string(), score: z.number() }))
      .optional()
      .describe(
        'Present for operation "classify": one entry per input label, sorted descending by score, scores summing to 1 across these labels',
      ),

    // "embed" and "embed-dinov2"
    embedding: z
      .array(z.number())
      .optional()
      .describe(
        'Present for operation "embed" (768-dim, CLIP) or "embed-dinov2" (384-dim, DINOv2), both L2-normalized. The two are NOT comparable to each other.',
      ),

    // "segment"
    found: z
      .boolean()
      .optional()
      .describe('Present for operation "segment": whether the prompted region was found above threshold'),
    box: boxSchema
      .nullable()
      .optional()
      .describe(
        'Present for operation "segment" (a derived bounding box, or null if not found) or "detect" (per-detection, always present). Pixel coordinates in the original image.',
      ),
    confidence: z
      .number()
      .optional()
      .describe('Present for operation "segment": mean sigmoid probability inside the returned box'),
    coverage: z
      .number()
      .optional()
      .describe('Present for operation "segment": fraction of image pixels above threshold'),

    // "detect"
    detections: z
      .array(z.object({ label: z.string(), score: z.number(), box: boxSchema }))
      .optional()
      .describe('Present for operation "detect": every match found, sorted descending by score'),

    // "pose"
    people: z
      .array(
        z.object({
          box: boxSchema,
          keypoints: z.array(
            z.object({ name: z.string(), x: z.number(), y: z.number(), score: z.number() }),
          ),
        }),
      )
      .optional()
      .describe(
        'Present for operation "pose": one entry per person box (input or default full-image), each with 17 COCO keypoints',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function activityLabel(operation: Input['operation'] | undefined): string {
  switch (operation) {
    case 'caption':
      return 'Captioning the image'
    case 'classify':
      return 'Classifying the image against candidate labels'
    case 'embed':
      return 'Computing a CLIP embedding for the image'
    case 'embed-dinov2':
      return 'Computing a DINOv2 embedding for the image'
    case 'segment':
      return 'Segmenting the image for the described region'
    case 'detect':
      return 'Detecting objects in the image'
    case 'pose':
      return 'Estimating human pose in the image'
    default:
      return 'Analyzing image'
  }
}

export const VisionAnalyzeTool = buildTool({
  name: TOOL_NAME,
  searchHint:
    'image captioning, zero-shot classification, object detection, text-prompted segmentation, pose estimation, and CLIP/DINOv2 embeddings',
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
  getPath(input) {
    return input.image_path
  },
  toAutoClassifierInput(input) {
    return input.image_path ?? ''
  },
  async validateInput(input) {
    const parsed = visionAnalyzeToolInputSchema().safeParse(input)
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
    // only), reading a file path the user/model already named — no
    // filesystem write or network side effect worth gating behind a
    // permission prompt. Same posture as AskMathModelTool/DocumentQATool/
    // ImageCaptionTool/DataAnalyzeTool/AudioAnalyzeTool, not a
    // code-execution tool.
    return { behavior: 'allow', updatedInput: input }
  },
  getActivityDescription(input) {
    const label = activityLabel(input?.operation)
    return input?.image_path ? `${label}: ${input.image_path}` : label
  },
  renderToolUseMessage() {
    return null
  },
  async call(rawInput, context) {
    const parsed = visionAnalyzeToolInputSchema().safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid VisionAnalyze input: ${parsed.error.message}`)
    }
    const input = parsed.data

    const { signal, cleanup } = createCombinedAbortSignal(context.abortController.signal, {
      timeoutMs: MODEL_BRIDGE_TIMEOUT_MS,
    })

    try {
      switch (input.operation) {
        case 'caption': {
          const result = await callImageCaption(input.image_path, signal)
          return { data: { operation: 'caption', caption: result.caption } satisfies Output }
        }
        case 'classify': {
          const predictions = await callClipClassify(input.image_path, input.labels, signal)
          return { data: { operation: 'classify', predictions } satisfies Output }
        }
        case 'embed': {
          const embedding = await callClipEmbed(input.image_path, signal)
          return { data: { operation: 'embed', embedding } satisfies Output }
        }
        case 'embed-dinov2': {
          const embedding = await callDinov2Embed(input.image_path, signal)
          return { data: { operation: 'embed-dinov2', embedding } satisfies Output }
        }
        case 'segment': {
          const result = await callClipSegSegment(
            input.image_path,
            input.prompt,
            input.threshold,
            signal,
          )
          return {
            data: {
              operation: 'segment',
              found: result.found,
              box: result.box,
              confidence: result.confidence,
              coverage: result.coverage,
            } satisfies Output,
          }
        }
        case 'detect': {
          const detections = await callOwlv2Detect(
            input.image_path,
            input.queries,
            input.threshold,
            signal,
          )
          return { data: { operation: 'detect', detections } satisfies Output }
        }
        case 'pose': {
          const people = await callVitPosePose(input.image_path, input.boxes, signal)
          return { data: { operation: 'pose', people } satisfies Output }
        }
      }
    } finally {
      cleanup()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    let content: string
    switch (output.operation) {
      case 'caption': {
        content = output.caption ?? ''
        break
      }
      case 'classify': {
        const predictions = output.predictions ?? []
        content =
          predictions.length === 0
            ? 'No predictions returned.'
            : predictions.map(p => `${p.label}: ${p.score.toFixed(3)}`).join('\n')
        break
      }
      case 'embed':
      case 'embed-dinov2': {
        const embedding = output.embedding ?? []
        content = `${embedding.length}-dim embedding computed.`
        break
      }
      case 'segment': {
        content = output.found
          ? `Found (confidence ${output.confidence?.toFixed(3)}, coverage ${output.coverage?.toFixed(3)}): box ${JSON.stringify(output.box)}`
          : 'Not found above the threshold.'
        break
      }
      case 'detect': {
        const detections = output.detections ?? []
        content =
          detections.length === 0
            ? 'No detections found.'
            : detections
                .map(d => `${d.label}: ${d.score.toFixed(3)} at ${JSON.stringify(d.box)}`)
                .join('\n')
        break
      }
      case 'pose': {
        const people = output.people ?? []
        content =
          people.length === 0
            ? 'No people found.'
            : `${people.length} ${people.length === 1 ? 'person' : 'people'} detected, ${people[0]?.keypoints.length ?? 0} keypoints each.`
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
// assert against directly (matches AskMathModelTool.ts/DataAnalyzeTool.ts's
// convention).
export { DESCRIPTION }
