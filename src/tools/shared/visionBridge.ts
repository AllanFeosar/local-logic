/**
 * Shared HTTP client for the Python bridge's vision routes — the five
 * Phase 5 "vision suite" routes (`POST /clip-classify`, `/clip-embed`,
 * `/clipseg-segment`, `/dinov2-embed`, `/owlv2-detect`, `/vitpose-pose`)
 * plus the pre-existing `POST /image-caption` route, all backing
 * `VisionAnalyzeTool` (see that tool's own file for the fold-BLIP-in
 * decision — this client's `callImageCaption` duplicates
 * `ImageCaptionTool.ts`'s own inline fetch call rather than one tool
 * invoking the other, matching how `AudioAnalyzeTool`/
 * `TranscribeAndSummarizeTool` each call `/transcribe`/`/vad` directly
 * through the shared `audioBridge.ts` rather than composing tool calls).
 *
 * See `.claude/contracts/tool-contract.md` §3 "Phase 5 vision-suite routes"
 * for the exact, live-verified request/response contract this implements
 * against.
 */
import {
  MODEL_BRIDGE_BASE_URL,
  modelBridgeUnavailableMessage,
} from './localModelBridge.js'

export type ClipClassifyPrediction = { label: string; score: number }
export type Box = { x1: number; y1: number; x2: number; y2: number }
export type ClipSegResult = {
  found: boolean
  box: Box | null
  confidence: number
  coverage: number
}
export type Owlv2Detection = { label: string; score: number; box: Box }
export type PoseKeypoint = { name: string; x: number; y: number; score: number }
export type PosePerson = { box: Box; keypoints: PoseKeypoint[] }

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
 * All seven routes this client calls return FastAPI's standard
 * `{"detail": "..."}` body on a non-2xx response (confirmed against
 * `python-bridge/server.py`'s `HTTPException(status_code=..., detail=...)`
 * calls) — extract that if present, otherwise fall back to the raw body
 * text. Mirrors `audioBridge.ts`'s identical helper.
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
 * Maps the bridge's documented error responses to something a caller can
 * act on:
 * - 404: the image is missing, unreadable, or an unsupported format — every
 *   one of these seven routes collapses "doesn't exist" and "exists but
 *   isn't a loadable image" into the same generic 404 server-side
 *   (`image_utils.load_image()` / `image_caption.py`'s own equivalent
 *   inline check — see `.claude/contracts/tool-contract.md` §3).
 * - 400: malformed input specific to the route (empty `labels`/`queries`/
 *   `prompt`, a malformed `boxes` entry).
 * - anything else: surfaced with the status plus whatever detail the bridge
 *   gave, never a bare "non-2xx response".
 */
async function throwForErrorResponse(
  response: Response,
  routeLabel: string,
  imagePath: string,
): Promise<never> {
  const detail = await readDetail(response)
  if (response.status === 404) {
    throw new Error(
      `Image file not found, unreadable, or not a supported format: ${imagePath}`,
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

/** `POST /image-caption` — BLIP captioning (folded into VisionAnalyze's "caption" operation). */
export async function callImageCaption(
  imagePath: string,
  signal: AbortSignal,
): Promise<{ caption: string }> {
  const response = await postJson('/image-caption', { image_path: imagePath }, signal)
  if (!response.ok) {
    await throwForErrorResponse(response, 'Captioning', imagePath)
  }
  return (await response.json()) as { caption: string }
}

/** `POST /clip-classify` — zero-shot classification against caller-supplied labels. */
export async function callClipClassify(
  imagePath: string,
  labels: string[],
  signal: AbortSignal,
): Promise<ClipClassifyPrediction[]> {
  const response = await postJson(
    '/clip-classify',
    { image_path: imagePath, labels },
    signal,
  )
  if (!response.ok) {
    await throwForErrorResponse(response, 'CLIP classification', imagePath)
  }
  const data = (await response.json()) as { predictions: ClipClassifyPrediction[] }
  return data.predictions
}

/** `POST /clip-embed` — 768-dim L2-normalized CLIP embedding. */
export async function callClipEmbed(
  imagePath: string,
  signal: AbortSignal,
): Promise<number[]> {
  const response = await postJson('/clip-embed', { image_path: imagePath }, signal)
  if (!response.ok) {
    await throwForErrorResponse(response, 'CLIP embedding', imagePath)
  }
  const data = (await response.json()) as { embedding: number[] }
  return data.embedding
}

/** `POST /dinov2-embed` — 384-dim L2-normalized DINOv2 embedding (NOT comparable to CLIP's space). */
export async function callDinov2Embed(
  imagePath: string,
  signal: AbortSignal,
): Promise<number[]> {
  const response = await postJson('/dinov2-embed', { image_path: imagePath }, signal)
  if (!response.ok) {
    await throwForErrorResponse(response, 'DINOv2 embedding', imagePath)
  }
  const data = (await response.json()) as { embedding: number[] }
  return data.embedding
}

/** `POST /clipseg-segment` — text-prompted segmentation, returns a derived bounding box. */
export async function callClipSegSegment(
  imagePath: string,
  prompt: string,
  threshold: number | undefined,
  signal: AbortSignal,
): Promise<ClipSegResult> {
  const response = await postJson(
    '/clipseg-segment',
    { image_path: imagePath, prompt, threshold },
    signal,
  )
  if (!response.ok) {
    await throwForErrorResponse(response, 'CLIPSeg segmentation', imagePath)
  }
  return (await response.json()) as ClipSegResult
}

/** `POST /owlv2-detect` — open-vocabulary object detection. */
export async function callOwlv2Detect(
  imagePath: string,
  queries: string[],
  threshold: number | undefined,
  signal: AbortSignal,
): Promise<Owlv2Detection[]> {
  const response = await postJson(
    '/owlv2-detect',
    { image_path: imagePath, queries, threshold },
    signal,
  )
  if (!response.ok) {
    await throwForErrorResponse(response, 'OWLv2 detection', imagePath)
  }
  const data = (await response.json()) as { detections: Owlv2Detection[] }
  return data.detections
}

/** `POST /vitpose-pose` — human pose estimation, `boxes` in COCO [x,y,w,h] format. */
export async function callVitPosePose(
  imagePath: string,
  boxes: number[][] | undefined,
  signal: AbortSignal,
): Promise<PosePerson[]> {
  const response = await postJson(
    '/vitpose-pose',
    { image_path: imagePath, boxes },
    signal,
  )
  if (!response.ok) {
    await throwForErrorResponse(response, 'Pose estimation', imagePath)
  }
  const data = (await response.json()) as { people: PosePerson[] }
  return data.people
}
