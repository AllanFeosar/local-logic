import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { callTranscribe, callVad } from '../shared/audioBridge.js'
import { MODEL_BRIDGE_TIMEOUT_MS } from '../shared/localModelBridge.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const TOOL_NAME = 'TranscribeAndSummarize'

const inputSchema = lazySchema(() =>
  z.strictObject({
    audio_path: z
      .string()
      .describe(
        'Absolute local filesystem path to a WAV audio file (mono or stereo, 8 or 16-bit PCM). Other formats (mp3, m4a, ogg, etc.) are not supported and will fail.',
      ),
    language: z
      .string()
      .optional()
      .describe(
        'Optional: force transcription in a specific spoken language (e.g. "en"). Omit to auto-detect — recommended unless you already know the language and have a specific reason to force it. An unrecognized value is rejected with a clear error.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    text: z
      .string()
      .describe(
        'The full transcript, ready for you to read/summarize in your own next turn — this tool does not summarize on its own. Empty string if had_speech is false.',
      ),
    language: z
      .string()
      .describe(
        'The detected (or explicitly supplied) spoken language. Empty string if had_speech is false.',
      ),
    segments: z
      .array(
        z.object({
          text: z.string(),
          start: z.number(),
          end: z.number(),
        }),
      )
      .describe(
        "Whisper's own transcript segments with start/end timestamps in seconds. Empty if had_speech is false.",
      ),
    speech_segments: z
      .array(z.object({ start: z.number(), end: z.number() }))
      .describe(
        'Voice-activity-detected speech segments (start/end in seconds) — where in the audio actual speech occurs, checked before transcription was attempted.',
      ),
    had_speech: z
      .boolean()
      .describe(
        'Whether voice-activity detection found any speech at all. If false, transcription was skipped entirely (text/language/segments are all empty) — this is a valid "no speech in this audio" result, not a failure.',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const TranscribeAndSummarizeTool = buildTool({
  name: TOOL_NAME,
  searchHint:
    'one-call audio transcription pipeline (speech detection then transcription) for "what does this recording say" / "transcribe and summarize this audio" requests',
  maxResultSizeChars: 20_000,
  // See AskMathModelTool.ts for why this is deliberately not deferred.
  shouldDefer: false,
  async description() {
    return 'Transcribing the audio (checking for speech first)'
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
    return input?.audio_path
      ? `Transcribing ${input.audio_path}`
      : 'Transcribing audio'
  },
  renderToolUseMessage() {
    return null
  },
  async call({ audio_path, language }, context) {
    // One combined signal/timeout covers both sequential bridge calls
    // below, not one timeout budget per call: VAD is near-instant
    // (~250x real-time, live-benchmarked — see LOCAL_AI_STATUS.md's Phase 4
    // session), so in practice almost the entire MODEL_BRIDGE_TIMEOUT_MS
    // budget is still available for the (slower) transcription call, and a
    // single wrapping signal also means a caller-supplied abort correctly
    // cancels the whole pipeline rather than just whichever leg happened to
    // be in flight.
    const { signal, cleanup } = createCombinedAbortSignal(context.abortController.signal, {
      timeoutMs: MODEL_BRIDGE_TIMEOUT_MS,
    })

    try {
      // VAD first, on the original (untrimmed) audio_path. Deliberately
      // NOT trimming the audio to the detected speech ranges before
      // transcribing (unlike the master plan's literal "VAD -> Whisper"
      // framing might suggest): doing that would mean re-implementing WAV
      // read/write/splice logic in TypeScript, duplicating
      // python-bridge/local_models/audio_utils.py's already-tested format
      // handling (8/16-bit PCM, mono/stereo) in a second language with its
      // own edge cases, for a gain Whisper's own long-form generation loop
      // already makes largely moot — it's live-verified to handle
      // multi-segment, >30s audio (including surrounding silence)
      // correctly in one pass (see LOCAL_AI_STATUS.md's Phase 4 session).
      // What VAD *does* meaningfully buy here, and the reason it still runs
      // first rather than going straight to /transcribe: if it finds zero
      // speech, this skips the transcription call entirely — the one case
      // where trimming would have helped (silence-only input) is exactly
      // the case handled without needing to touch the audio bytes at all.
      const speechSegments = await callVad(audio_path, {}, signal)

      if (speechSegments.length === 0) {
        return {
          data: {
            text: '',
            language: '',
            segments: [],
            speech_segments: [],
            had_speech: false,
          } satisfies Output,
        }
      }

      const result = await callTranscribe(audio_path, language, signal)
      return {
        data: {
          text: result.text,
          language: result.language,
          segments: result.segments,
          speech_segments: speechSegments,
          had_speech: true,
        } satisfies Output,
      }
    } finally {
      cleanup()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const content = output.had_speech
      ? `[language: ${output.language}]\n${output.text}`
      : 'No speech detected in this audio — nothing to transcribe.'
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
