import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { callTranscribe, callVad } from '../shared/audioBridge.js'
import { MODEL_BRIDGE_TIMEOUT_MS } from '../shared/localModelBridge.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { audioAnalyzeToolInputSchema } from './schemas.js'

const TOOL_NAME = 'AudioAnalyze'

/**
 * Tool-facing input schema: a flat ZodObject with every per-operation field
 * marked optional (rather than the discriminated union in schemas.ts — see
 * that file's comment, mirroring `DataAnalyzeTool/schemas.ts`).
 * validateInput()/call() re-validate against the discriminated union to
 * enforce which fields are actually valid for the chosen operation and to
 * produce a precise error message.
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['transcribe', 'vad'])
      .describe(
        'Which audio task to perform: "transcribe" converts speech to text, "vad" (voice-activity detection) finds WHERE speech occurs without transcribing it. Pick exactly one.',
      ),
    audio_path: z
      .string()
      .describe(
        'Absolute local filesystem path to a WAV audio file (mono or stereo, 8 or 16-bit PCM). Required for both operations. Other formats (mp3, m4a, ogg, etc.) are not supported and will fail.',
      ),

    // operation: "transcribe"
    language: z
      .string()
      .optional()
      .describe(
        'Optional, only used by operation "transcribe": force transcription in a specific spoken language (e.g. "en"). Omit to auto-detect — recommended unless you already know the language and have a specific reason to force it. An unrecognized value is rejected with a clear error.',
      ),

    // operation: "vad"
    threshold: z
      .number()
      .optional()
      .describe(
        'Optional, only used by operation "vad": speech-probability threshold in (0, 1), default 0.5 — higher is stricter about what counts as speech.',
      ),
    min_speech_duration_ms: z
      .number()
      .optional()
      .describe(
        'Optional, only used by operation "vad": minimum duration (ms) for a detected region to count as speech, default 250.',
      ),
    min_silence_duration_ms: z
      .number()
      .optional()
      .describe(
        'Optional, only used by operation "vad": minimum silence duration (ms) required to split two speech segments apart, default 100.',
      ),
    speech_pad_ms: z
      .number()
      .optional()
      .describe(
        'Optional, only used by operation "vad": padding (ms) added to each side of a detected speech segment, default 30.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    operation: z
      .enum(['transcribe', 'vad'])
      .describe('Which operation this result is for'),

    // "transcribe"
    text: z
      .string()
      .optional()
      .describe('Present for operation "transcribe": the full transcript'),
    language: z
      .string()
      .optional()
      .describe(
        'Present for operation "transcribe": the detected (or explicitly supplied) spoken language',
      ),
    segments: z
      .array(
        z.object({
          text: z.string(),
          start: z.number(),
          end: z.number(),
        }),
      )
      .optional()
      .describe(
        'Present for operation "transcribe": transcript segments with start/end timestamps in seconds',
      ),

    // "vad"
    speech_segments: z
      .array(z.object({ start: z.number(), end: z.number() }))
      .optional()
      .describe(
        'Present for operation "vad": detected speech segments (start/end in seconds). Empty means no speech was detected.',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function activityLabel(operation: Input['operation'] | undefined): string {
  switch (operation) {
    case 'transcribe':
      return 'Transcribing the audio'
    case 'vad':
      return 'Detecting speech segments in the audio'
    default:
      return 'Analyzing audio'
  }
}

export const AudioAnalyzeTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'audio transcription and voice-activity (speech segment) detection',
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
    return input.audio_path
  },
  toAutoClassifierInput(input) {
    return input.audio_path ?? ''
  },
  async validateInput(input) {
    const parsed = audioAnalyzeToolInputSchema().safeParse(input)
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
    // ImageCaptionTool/DataAnalyzeTool, not a code-execution tool.
    return { behavior: 'allow', updatedInput: input }
  },
  getActivityDescription(input) {
    const label = activityLabel(input?.operation)
    return input?.audio_path ? `${label}: ${input.audio_path}` : label
  },
  renderToolUseMessage() {
    return null
  },
  async call(rawInput, context) {
    const parsed = audioAnalyzeToolInputSchema().safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid AudioAnalyze input: ${parsed.error.message}`)
    }
    const input = parsed.data

    const { signal, cleanup } = createCombinedAbortSignal(context.abortController.signal, {
      timeoutMs: MODEL_BRIDGE_TIMEOUT_MS,
    })

    try {
      switch (input.operation) {
        case 'transcribe': {
          const result = await callTranscribe(input.audio_path, input.language, signal)
          return {
            data: {
              operation: 'transcribe',
              text: result.text,
              language: result.language,
              segments: result.segments,
            } satisfies Output,
          }
        }
        case 'vad': {
          const segments = await callVad(
            input.audio_path,
            {
              threshold: input.threshold,
              min_speech_duration_ms: input.min_speech_duration_ms,
              min_silence_duration_ms: input.min_silence_duration_ms,
              speech_pad_ms: input.speech_pad_ms,
            },
            signal,
          )
          return {
            data: {
              operation: 'vad',
              speech_segments: segments,
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
      case 'transcribe': {
        const segCount = output.segments?.length ?? 0
        content =
          `[language: ${output.language ?? 'unknown'}]\n${output.text ?? ''}` +
          (segCount > 0
            ? `\n\n(${segCount} segment${segCount === 1 ? '' : 's'} with timestamps available)`
            : '')
        break
      }
      case 'vad': {
        const segments = output.speech_segments ?? []
        content =
          segments.length === 0
            ? 'No speech detected in this audio.'
            : `${segments.length} speech segment${segments.length === 1 ? '' : 's'} detected: ` +
              segments.map(s => `${s.start.toFixed(2)}-${s.end.toFixed(2)}s`).join(', ')
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
