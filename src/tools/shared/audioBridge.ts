/**
 * Shared HTTP client for the Python bridge's Phase 4 "hearing" routes
 * (`POST /transcribe`, `POST /vad`) — used by both `AudioAnalyzeTool` (the
 * general-purpose gateway, exposing each capability directly) and
 * `TranscribeAndSummarizeTool` (the fixed VAD -> Whisper pipeline), so the
 * request/response shapes and the 404/400 error-mapping logic live in
 * exactly one place rather than being duplicated across two tools that both
 * talk to the same two routes.
 *
 * See `.claude/contracts/tool-contract.md` §3 "Phase 4 hearing routes" for
 * the exact, live-verified contract this implements against.
 */
import {
  MODEL_BRIDGE_BASE_URL,
  modelBridgeUnavailableMessage,
} from './localModelBridge.js'

export type TranscribeSegment = { text: string; start: number; end: number }
export type TranscribeResult = {
  text: string
  language: string
  segments: TranscribeSegment[]
}

export type VadSegment = { start: number; end: number }

export type VadOptions = {
  threshold?: number
  min_speech_duration_ms?: number
  min_silence_duration_ms?: number
  speech_pad_ms?: number
}

/**
 * Extensions this project's own image tools (ImageCaptionTool,
 * VisionAnalyzeTool) treat as images — not exhaustive, just the common
 * cases worth catching before a wasted round trip to the bridge.
 */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

/**
 * Session 29 finding: the router sometimes calls TranscribeAndSummarize/
 * AudioAnalyze on an image path instead of ImageCaption/VisionAnalyze
 * (live-verified, e.g. holdout-caption-1's persistent failure). Previously
 * this reached the bridge, which correctly 404'd with a generic
 * "not found, unreadable, or not a supported format" message — technically
 * accurate but not actionable: it doesn't tell the caller WHY the format is
 * wrong or what to call instead. A same-session live test showed the
 * router CAN self-correct mid-conversation when a tool error explicitly
 * names the right tool (observed during file-read retrieval testing this
 * session) — so this catches the obviously-wrong-extension case client-side,
 * before any bridge round trip, with a message built to be actionable on
 * the router's own next turn rather than just technically correct. Not a
 * full-format detector (magic-byte sniffing) — it only catches the common,
 * confidently-wrong case; anything else still falls through to the
 * bridge's own real format validation below.
 */
function rejectIfObviouslyNotAudio(audioPath: string): void {
  const lower = audioPath.toLowerCase()
  const ext = IMAGE_EXTENSIONS.find(e => lower.endsWith(e))
  if (ext) {
    throw new Error(
      `${audioPath} looks like an image file (${ext}), not audio — this tool only accepts WAV audio. ` +
        `For "what's in this image" style requests, use ImageCaption or VisionAnalyze instead.`,
    )
  }
}

async function postJson(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(`${MODEL_BRIDGE_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (cause) {
    throw new Error(modelBridgeUnavailableMessage(cause))
  }
}

/**
 * The bridge returns FastAPI's standard `{"detail": "..."}` body on every
 * non-2xx response from these two routes (confirmed against
 * `python-bridge/server.py`'s `HTTPException(status_code=..., detail=...)`
 * calls for `/transcribe`/`/vad`) — extract that if present, otherwise fall
 * back to the raw body text.
 */
async function readDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown }
    if (typeof parsed.detail === 'string') return parsed.detail
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return raw
}

/**
 * Maps the bridge's documented error responses to something a caller (the
 * model reading the tool_result) can actually act on, rather than a raw
 * HTTP status leaking through:
 * - 404: the file is missing, unreadable, or an unsupported format — both
 *   `/transcribe` and `/vad` deliberately collapse "doesn't exist" and
 *   "exists but isn't a loadable WAV" into the same generic 404 server-side
 *   (see `audio_utils.py`'s module docstring for why — same reasoning as
 *   `/image-caption`'s existing missing-vs-unloadable collapse). WAV only
 *   (8/16-bit PCM, mono or stereo) — mp3/m4a/etc. are rejected outright,
 *   never silently mistranscribed.
 * - 400: an explicitly-supplied `language` wasn't recognized (`/transcribe`
 *   only — `/vad` has no language parameter, so this shouldn't occur there
 *   in practice, but is still handled the same way if it ever does).
 * - anything else (e.g. a 422 from Pydantic's own field validation on `/vad`
 *   if a caller somehow bypasses this tool's own client-side zod
 *   constraints): surfaced with the status plus whatever detail the bridge
 *   gave, never a bare "non-2xx response".
 */
async function throwForErrorResponse(
  response: Response,
  routeLabel: string,
  audioPath: string,
): Promise<never> {
  const detail = await readDetail(response)
  if (response.status === 404) {
    throw new Error(
      `Audio file not found, unreadable, or not a supported format (WAV only — 8/16-bit PCM, mono or stereo; mp3/m4a/etc. are rejected, not mistranscribed): ${audioPath}`,
    )
  }
  if (response.status === 400) {
    throw new Error(
      `${routeLabel} rejected the request: ${detail || response.statusText}`,
    )
  }
  throw new Error(
    `${routeLabel} request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
  )
}

/** `POST /transcribe` — `language` omitted lets the response auto-detect. */
export async function callTranscribe(
  audioPath: string,
  language: string | undefined,
  signal: AbortSignal,
): Promise<TranscribeResult> {
  rejectIfObviouslyNotAudio(audioPath)
  const response = await postJson(
    '/transcribe',
    { audio_path: audioPath, language },
    signal,
  )
  if (!response.ok) {
    await throwForErrorResponse(response, 'Transcription', audioPath)
  }
  return (await response.json()) as TranscribeResult
}

/** `POST /vad` — returns just the speech segments, not a transcription. */
export async function callVad(
  audioPath: string,
  options: VadOptions,
  signal: AbortSignal,
): Promise<VadSegment[]> {
  rejectIfObviouslyNotAudio(audioPath)
  const response = await postJson(
    '/vad',
    { audio_path: audioPath, ...options },
    signal,
  )
  if (!response.ok) {
    await throwForErrorResponse(response, 'Voice-activity detection', audioPath)
  }
  const data = (await response.json()) as { segments: VadSegment[] }
  return data.segments
}
