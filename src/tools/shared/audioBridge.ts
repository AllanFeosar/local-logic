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
