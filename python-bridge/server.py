"""
Local model bridge for openclaude-main.

Serves the downloaded HF/PyTorch mini models (the ones that aren't
Ollama-servable GGUF files) over a small local HTTP API, so tools in the
Bun/TypeScript agentic app can call out to them the same way they call out
to Ollama for the math model.

Run with:  python server.py   (or via start.ps1, which points at an existing
venv with fastapi/uvicorn/transformers/torch already installed).

Extending to another downloaded model: copy local_models/document_qa.py or
local_models/image_caption.py as a template — each one:
  1. defines a `_do_load(device)` that imports its (concrete, not
     Auto*/pipeline()) model classes, places the model on `device` (a
     resolved "cuda" or "cpu" string the manager passes in — see
     local_models/manager.py's docstring for how "cuda" gets resolved and
     falls back to "cpu" automatically), and returns a handle (any object —
     a tuple of model+tokenizer/processor is typical; include the device
     string in that tuple if the inference function needs to move input
     tensors onto it too),
  2. registers a `local_models.manager.ModelSpec` for itself at import time
     (name, loader, an estimated_mb footprint, heavy/device/fp16 flags —
     device="cuda" is only worth declaring for a model actually worth GPU
     placement; the tiny Phase-3 tabular/table/forecast models all declare
     device="cpu"),
  3. wraps its sync inference function's model access in
     `with manager.use(name) as handle: ...` instead of a private
     `_model`/`_tokenizer` global,
  4. keeps the same asyncio.to_thread-wrapped async version for use inside
     FastAPI without blocking the event loop during CPU-bound inference.
Then add one route below that calls the async version. That's the whole
pattern — no other file needs to change. The shared `local_models.manager`
(see its own docstring) is what actually owns loading/eviction/budget
tracking/device placement across every registered model — don't
reintroduce a per-module lazy-singleton, it'll drift out of sync with
budget/LRU/heavy-exclusivity/device resolution.
"""
import logging
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Literal, Optional, Union

from local_models import audio_utils, document_qa, image_caption, table_qa, tabular_predict, vad as vad_model
from local_models import forecast as forecast_model
from local_models import transcribe as transcribe_model
from local_models import clip as clip_model
from local_models import clipseg as clipseg_model
from local_models import dinov2 as dinov2_model
from local_models import owlv2 as owlv2_model
from local_models import vitpose as vitpose_model
from local_models.manager import manager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("model_bridge")

app = FastAPI(title="openclaude-main local model bridge")

# Security review note (2026-08-12): this bridge binds to 127.0.0.1 only
# (see uvicorn.run below) so it's never reachable off-machine directly, but
# loopback binding alone doesn't stop DNS rebinding — a page the machine's
# user has open in a browser can resolve an attacker-controlled hostname to
# 127.0.0.1 after the fact and issue same-origin requests here. Rejecting
# any request whose Host header isn't 127.0.0.1/localhost closes that route
# cheaply; the real TS caller always talks to this bridge by IP/port
# directly, so this has no legitimate-traffic cost.
_ALLOWED_HOSTS = {"127.0.0.1", "localhost"}


@app.middleware("http")
async def reject_unexpected_host(request: Request, call_next):
    host = request.headers.get("host", "").split(":", 1)[0].lower()
    if host not in _ALLOWED_HOSTS:
        logger.warning("rejected request with unexpected Host header: %r", host)
        return JSONResponse(status_code=403, content={"detail": "forbidden"})
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/status")
async def status():
    """What's currently loaded, the declared/estimated committed MB against
    the configured budget, and a real current-process RSS reading. For
    debugging and for the eval harness (scripts/eval/specialistEval.ts and
    successors) to check bridge memory behavior across a run.
    """
    return manager.status()


class DocumentQARequest(BaseModel):
    question: str
    context: str


class DocumentQAResponse(BaseModel):
    answer: str
    score: float


@app.post("/document-qa", response_model=DocumentQAResponse)
async def document_qa_endpoint(req: DocumentQARequest):
    if not req.context.strip():
        raise HTTPException(status_code=400, detail="context must not be empty")
    result = await document_qa.answer_async(req.question, req.context)
    return DocumentQAResponse(**result)


class ImageCaptionRequest(BaseModel):
    image_path: str


class ImageCaptionResponse(BaseModel):
    caption: str


@app.post("/image-caption", response_model=ImageCaptionResponse)
async def image_caption_endpoint(req: ImageCaptionRequest):
    try:
        result = await image_caption.caption_async(req.image_path)
    except FileNotFoundError:
        # Deliberately the same 404, with the same generic detail, as the
        # OSError case below — see image_caption.py's caption() docstring
        # note. Do not reintroduce a distinct message/status here; that
        # would resurrect the existence-oracle this collapse closes.
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except OSError:
        # Covers PIL.UnidentifiedImageError (an OSError subclass) and other
        # I/O failures opening an existing-but-unusable path — collapsed
        # into the same response as "not found" (see above).
        raise HTTPException(status_code=404, detail="image not found or not readable")
    return ImageCaptionResponse(caption=result)


# --- Phase 3: data/tables (2026-08-12) ------------------------------------
# Contract fixed in advance in .claude/contracts/tool-contract.md's
# "Planned routes (2026-08-12)" table so tools-execution-agent could build
# DataAnalyzeTool against these shapes in parallel. If you change a shape
# here, update that table in the same change — don't let it drift.


class TabularPredictRequest(BaseModel):
    operation: Literal["classify", "regress"]
    train_features: list[list[float]]
    train_labels: list[Union[str, float]]
    test_features: list[list[float]]


class TabularPredictResponse(BaseModel):
    predictions: list[Union[str, float]]
    probabilities: Optional[list[list[float]]] = None


@app.post("/tabular-predict", response_model=TabularPredictResponse)
async def tabular_predict_endpoint(req: TabularPredictRequest):
    try:
        result = await tabular_predict.predict_async(
            req.operation, req.train_features, req.train_labels, req.test_features
        )
    except tabular_predict.InvalidTabularInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    return TabularPredictResponse(**result)


class TableSpec(BaseModel):
    columns: list[str]
    rows: list[list[str]]


class TableQARequest(BaseModel):
    question: str
    table: TableSpec


class TableCell(BaseModel):
    row: int
    column: int


class TableQAResponse(BaseModel):
    answer: str
    cells: list[TableCell]


@app.post("/table-qa", response_model=TableQAResponse)
async def table_qa_endpoint(req: TableQARequest):
    try:
        result = await table_qa.answer_async(req.question, req.table.columns, req.table.rows)
    except table_qa.InvalidTableInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    return TableQAResponse(**result)


class ForecastRequest(BaseModel):
    series: list[float]
    horizon: int = Field(gt=0)


class ForecastResponse(BaseModel):
    forecast: list[float]
    low: Optional[list[float]] = None
    high: Optional[list[float]] = None


@app.post("/forecast", response_model=ForecastResponse)
async def forecast_endpoint(req: ForecastRequest):
    try:
        result = await forecast_model.forecast_async(req.series, req.horizon)
    except forecast_model.InvalidForecastInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ForecastResponse(**result)


# --- Phase 4: hearing (2026-08-13) ----------------------------------------
# Contract added to .claude/contracts/tool-contract.md's §3 table in the
# same change as these routes went live, for tools-execution-agent's
# AudioAnalyze/TranscribeAndSummarize tools (built separately, later — not
# part of this dispatch) to build against.


class TranscribeRequest(BaseModel):
    audio_path: str
    # None (default) lets Whisper auto-detect the spoken language rather
    # than forcing one — see transcribe.py's transcribe() docstring/comment
    # for what an unrecognized value does (400, not 500).
    language: Optional[str] = None


class TranscribeSegment(BaseModel):
    text: str
    start: float
    end: float


class TranscribeResponse(BaseModel):
    text: str
    language: str
    segments: list[TranscribeSegment]


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_endpoint(req: TranscribeRequest):
    try:
        result = await transcribe_model.transcribe_async(req.audio_path, req.language)
    except FileNotFoundError:
        # Same collapsed 404 as /image-caption and /vad below — see
        # audio_utils.py's UnsupportedAudioError docstring for why "doesn't
        # exist" and "exists but unreadable" are deliberately not
        # distinguished on this unauthenticated local endpoint.
        raise HTTPException(status_code=404, detail="audio file not found or not readable")
    except audio_utils.UnsupportedAudioError:
        raise HTTPException(status_code=404, detail="audio file not found or not readable")
    except transcribe_model.InvalidAudioInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    return TranscribeResponse(**result)


class VadRequest(BaseModel):
    audio_path: str
    threshold: float = Field(0.5, gt=0.0, lt=1.0)
    min_speech_duration_ms: float = Field(250.0, gt=0)
    min_silence_duration_ms: float = Field(100.0, gt=0)
    speech_pad_ms: float = Field(30.0, ge=0)


class VadSegment(BaseModel):
    start: float
    end: float


class VadResponse(BaseModel):
    segments: list[VadSegment]


@app.post("/vad", response_model=VadResponse)
async def vad_endpoint(req: VadRequest):
    try:
        result = await vad_model.detect_speech_segments_async(
            req.audio_path,
            req.threshold,
            req.min_speech_duration_ms,
            req.min_silence_duration_ms,
            req.speech_pad_ms,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="audio file not found or not readable")
    except audio_utils.UnsupportedAudioError:
        raise HTTPException(status_code=404, detail="audio file not found or not readable")
    except vad_model.InvalidAudioInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    return VadResponse(segments=result)


# --- Phase 5: vision suite (2026-08-13) ------------------------------------
# Contract added to .claude/contracts/tool-contract.md's §3 table in the
# same change as these routes went live, for tools-execution-agent's future
# VisionAnalyze gateway tool (not part of this dispatch) to build against.
# All five routes share the same 404 reasoning as /image-caption: a missing
# file and an existing-but-unloadable file are deliberately collapsed into
# the same generic 404 (see local_models/image_utils.py's load_image()
# docstring) rather than distinguished, closing the same filesystem-
# existence-oracle gap the /image-caption security review already fixed —
# don't reintroduce a distinct message/status for either case here.


class ClipClassifyRequest(BaseModel):
    image_path: str
    labels: list[str]


class ClipPrediction(BaseModel):
    label: str
    score: float


class ClipClassifyResponse(BaseModel):
    predictions: list[ClipPrediction]


@app.post("/clip-classify", response_model=ClipClassifyResponse)
async def clip_classify_endpoint(req: ClipClassifyRequest):
    try:
        result = await clip_model.classify_async(req.image_path, req.labels)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except OSError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except clip_model.InvalidClipInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ClipClassifyResponse(**result)


class ClipEmbedRequest(BaseModel):
    image_path: str


class ClipEmbedResponse(BaseModel):
    embedding: list[float]


@app.post("/clip-embed", response_model=ClipEmbedResponse)
async def clip_embed_endpoint(req: ClipEmbedRequest):
    try:
        result = await clip_model.embed_async(req.image_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except OSError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    return ClipEmbedResponse(**result)


class ClipsegSegmentRequest(BaseModel):
    image_path: str
    prompt: str
    threshold: float = Field(0.5, gt=0.0, lt=1.0)


class ClipsegBox(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int


class ClipsegSegmentResponse(BaseModel):
    found: bool
    box: Optional[ClipsegBox] = None
    confidence: float
    coverage: float


@app.post("/clipseg-segment", response_model=ClipsegSegmentResponse)
async def clipseg_segment_endpoint(req: ClipsegSegmentRequest):
    try:
        result = await clipseg_model.segment_async(req.image_path, req.prompt, req.threshold)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except OSError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except clipseg_model.InvalidClipsegInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ClipsegSegmentResponse(**result)


class Dinov2EmbedRequest(BaseModel):
    image_path: str


class Dinov2EmbedResponse(BaseModel):
    embedding: list[float]


@app.post("/dinov2-embed", response_model=Dinov2EmbedResponse)
async def dinov2_embed_endpoint(req: Dinov2EmbedRequest):
    try:
        result = await dinov2_model.embed_async(req.image_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except OSError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    return Dinov2EmbedResponse(**result)


class Owlv2DetectRequest(BaseModel):
    image_path: str
    queries: list[str]
    threshold: float = Field(0.1, gt=0.0, lt=1.0)


class Owlv2Box(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class Owlv2Detection(BaseModel):
    label: str
    score: float
    box: Owlv2Box


class Owlv2DetectResponse(BaseModel):
    detections: list[Owlv2Detection]


@app.post("/owlv2-detect", response_model=Owlv2DetectResponse)
async def owlv2_detect_endpoint(req: Owlv2DetectRequest):
    try:
        result = await owlv2_model.detect_async(req.image_path, req.queries, req.threshold)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except OSError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except owlv2_model.InvalidOwlv2Input as e:
        raise HTTPException(status_code=400, detail=str(e))
    return Owlv2DetectResponse(**result)


class VitposePoseRequest(BaseModel):
    image_path: str
    # COCO format per box: [x, y, width, height]. None (default) falls back
    # to a single full-image box — see local_models/vitpose.py's module
    # docstring for why (no person detector composed at the bridge layer).
    boxes: Optional[list[list[float]]] = None


class VitposeBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class VitposeKeypoint(BaseModel):
    name: str
    x: float
    y: float
    score: float


class VitposePerson(BaseModel):
    box: VitposeBox
    keypoints: list[VitposeKeypoint]


class VitposePoseResponse(BaseModel):
    people: list[VitposePerson]


@app.post("/vitpose-pose", response_model=VitposePoseResponse)
async def vitpose_pose_endpoint(req: VitposePoseRequest):
    try:
        result = await vitpose_model.pose_async(req.image_path, req.boxes)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except OSError:
        raise HTTPException(status_code=404, detail="image not found or not readable")
    except vitpose_model.InvalidVitposeInput as e:
        raise HTTPException(status_code=400, detail=str(e))
    return VitposePoseResponse(**result)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MODEL_BRIDGE_PORT", "8756"))
    uvicorn.run(app, host="127.0.0.1", port=port)
