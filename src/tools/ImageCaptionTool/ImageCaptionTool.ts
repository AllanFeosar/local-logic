import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  MODEL_BRIDGE_BASE_URL,
  MODEL_BRIDGE_TIMEOUT_MS,
  modelBridgeUnavailableMessage,
} from '../shared/localModelBridge.js'

const TOOL_NAME = 'ImageCaption'

const DESCRIPTION = `Generates a short natural-language caption describing the contents of a local image file, via a local captioning model (blip-image-captioning-large). Use this when you need a description of what's in an image you can't otherwise inspect. It produces a single generic description (e.g. "a dog running on a beach"), not detailed analysis, OCR, or answers to specific questions about the image — for those, still needs a real vision-capable model.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    image_path: z.string().describe('Absolute local filesystem path to the image file'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    caption: z.string().describe('The generated caption'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ImageCaptionTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'generate a caption describing a local image file',
  maxResultSizeChars: 5_000,
  // See AskMathModelTool.ts for why this is deliberately not deferred.
  shouldDefer: false,
  async description() {
    return 'Captioning the image'
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
  getPath(input) {
    return input.image_path
  },
  toAutoClassifierInput(input) {
    return input.image_path
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  getActivityDescription(input) {
    return input?.image_path ? `Captioning ${input.image_path}` : 'Captioning image'
  },
  renderToolUseMessage() {
    return null
  },
  async call({ image_path }, context) {
    const { signal, cleanup } = createCombinedAbortSignal(context.abortController.signal, {
      timeoutMs: MODEL_BRIDGE_TIMEOUT_MS,
    })

    try {
      let response: Response
      try {
        response = await fetch(`${MODEL_BRIDGE_BASE_URL}/image-caption`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_path }),
          signal,
        })
      } catch (cause) {
        throw new Error(modelBridgeUnavailableMessage(cause))
      }

      if (response.status === 404) {
        throw new Error(`Image file not found: ${image_path}`)
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Image caption request failed: ${response.status} ${response.statusText} ${body}`)
      }

      const data = (await response.json()) as Output
      return { data }
    } finally {
      cleanup()
    }
  },
  mapToolResultToToolResultBlockParam({ caption }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: caption,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
